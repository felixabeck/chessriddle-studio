pub(crate) use native_tests::{game, Fixture};

#[cfg(test)]
mod native_tests {
    use super::super::*;
    use crate::file_workspace::{WorkspaceFileContent, WorkspaceMetadata};
    use crate::infra::fs;
    use crate::infra::path_authority::{PathAuthority, PathClass};
    use std::{path::PathBuf, time::Duration};

    pub(crate) struct Fixture {
        pub directory: tempfile::TempDir,
        pub state: AppState,
        pub workspace: FileWorkspaceHandle,
        pub service: Arc<CollectionService>,
    }

    pub(crate) fn game(id: Option<&str>, moves: &str, note: &str) -> String {
        format!("[Event \"Collection fixture\"]\n[Site \"https://www.chess.com\"]\n[Date \"2026.10.01\"]\n[UTCTime \"12:00:00\"]\n[White \"Player\"]\n[Black \"Opponent\"]\n[Result \"1-0\"]\n{}[Custom \"keep this tag\"]\n\n1. {moves} {{{note}}} 1-0\n\n", id.map(|id| format!("[Link \"https://www.chess.com/game/live/{id}\"]\n")).unwrap_or_default())
    }

    #[test]
    fn trashed_source_keeps_identity_across_same_name_recreation_restart_and_restore() {
        let mut fixture = Fixture::new();
        let source = fixture.create(
            "games",
            &game(None, "e4 e5", "original"),
            WorkspaceFileType::Game,
        );
        let original = fixture.list().remove(0);
        fixture.trash(&source);
        let trashed = fixture.list().remove(0);
        assert_eq!(trashed.status, CollectionStatus::Trashed);
        assert_eq!(trashed.id, original.id);
        assert_eq!(trashed.database, original.database);
        assert_eq!(
            fixture
                .service
                .record(
                    Uuid::parse_str(&original.id).unwrap(),
                    &CancellationToken::new()
                )
                .unwrap()
                .locator,
            vec![OsString::from("games.pgn")]
        );
        assert_eq!(
            fixture
                .service
                .metadata_for_database(
                    &fixture.state.pgn_path_authority,
                    original.database.as_ref().unwrap(),
                    &CancellationToken::new()
                )
                .unwrap()
                .unwrap()
                .status,
            CollectionStatus::Trashed
        );
        assert!(fixture
            .service
            .current_record(
                &fixture.state.pgn_path_authority,
                Uuid::parse_str(&original.id).unwrap(),
                &CancellationToken::new()
            )
            .is_err());
        let replacement = fixture.create(
            "games",
            &game(None, "d4 d5", "new"),
            WorkspaceFileType::Game,
        );
        let records = fixture.list();
        assert_eq!(records.len(), 2);
        assert!(records.iter().any(|record| record.id != original.id
            && record.file == replacement
            && record.status == CollectionStatus::Ready));
        assert!(records.iter().any(|record| record.id == original.id
            && record.file == source
            && record.status == CollectionStatus::Trashed));
        fixture.restart();
        assert_eq!(
            fixture
                .list()
                .iter()
                .find(|record| record.id == original.id)
                .unwrap()
                .status,
            CollectionStatus::Trashed
        );
        assert_eq!(
            fixture
                .service
                .record(
                    Uuid::parse_str(&original.id).unwrap(),
                    &CancellationToken::new()
                )
                .unwrap()
                .locator,
            vec![OsString::from("games.pgn")]
        );
        fixture.trash(&replacement);
        fixture.restore(&source);
        let restored = fixture
            .list()
            .into_iter()
            .find(|record| record.id == original.id)
            .unwrap();
        assert_eq!(restored.status, CollectionStatus::Ready);
        assert_eq!(restored.file, source);
        assert_eq!(restored.database, original.database);
    }

    #[test]
    fn trashed_source_removal_retries_and_respects_other_cache_owners() {
        let mut fixture = Fixture::new();
        let source = fixture.create(
            "games",
            &game(None, "e4 e5", "original"),
            WorkspaceFileType::Game,
        );
        let original = fixture.list().remove(0);
        let id = Uuid::parse_str(&original.id).unwrap();
        let evidence = format!("{id}-identity.db3");
        std::fs::write(fixture.service.root.path().join(&evidence), b"evidence").unwrap();
        fixture.trash(&source);
        fixture.list();
        let locator = fixture
            .service
            .record(id, &CancellationToken::new())
            .unwrap()
            .trash_locator;
        let trash_path = locator
            .iter()
            .fold(fixture.directory.path().join("library"), |path, leaf| {
                path.join(leaf)
            });
        std::fs::remove_file(trash_path).unwrap();
        let cache = fixture.service.root.path().join(format!("{id}.db3"));
        let token = CancellationToken::new();
        // A pending creation with this identity still owns the cache and identity evidence.
        let mut guard = fixture.service.lock(&token).unwrap();
        let mut registry = CollectionService::state(&mut guard).unwrap().clone();
        let record = registry.records[0].clone();
        registry.creations.push(CreationIntent {
            id,
            workspace: fixture.workspace.clone(),
            name: "other".into(),
            account: AccountIdentity {
                provider: "lichess".into(),
                account: "player".into(),
            },
            identity: None,
        });
        let mut candidate = registry.clone();
        candidate.records.clear();
        fixture
            .service
            .remove_record_files(&record, &candidate, &token)
            .unwrap();
        assert!(cache.exists());
        assert!(fixture.service.root.path().join(&evidence).exists());
        candidate.creations.clear();
        let batch_id = Uuid::new_v4();
        let mut batch_record = record.clone();
        batch_record.pending = Some(
            serde_json::from_value(serde_json::json!({
                "id": batch_id, "source": source, "owned_source": null, "source_revision": "batch",
                "identity": null, "completed": false, "coverage": null
            }))
            .unwrap(),
        );
        let shared_batch = format!("{batch_id}-batch.pgn");
        std::fs::write(fixture.service.root.path().join(&shared_batch), b"batch").unwrap();
        let mut other = batch_record.clone();
        other.id = Uuid::new_v4();
        candidate.records.push(other);
        candidate.migrations.push(MigrationIntent {
            id: Uuid::new_v4(),
            workspace: fixture.workspace.clone(),
            database: original.database.clone().unwrap(),
            database_identity: (0, 0),
            database_revision: 0,
            source: Some(source.clone()),
            source_revision: None,
            choice: MigrationChoice::Database,
            account: None,
            destination_name: "migration".into(),
            archive_identity: None,
            archive_ready: false,
            source_archive_identity: None,
            export_identity: None,
            destination: None,
            destination_identity: None,
            collection: Some(id),
            original_collection: None,
        });
        fixture
            .service
            .remove_record_files(&batch_record, &candidate, &token)
            .unwrap();
        assert!(cache.exists());
        assert!(fixture.service.root.path().join(&evidence).exists());
        assert!(fixture.service.root.path().join(&shared_batch).exists());
        registry.creations.clear();
        registry.migrations = candidate.migrations;
        fixture.service.save(&mut guard, registry).unwrap();
        drop(guard);
        assert_eq!(fixture.list()[0].status, CollectionStatus::Trashed);
        fixture.restart();
        assert_eq!(fixture.list()[0].status, CollectionStatus::Trashed);
        let mut guard = fixture.service.lock(&token).unwrap();
        let mut registry = CollectionService::state(&mut guard).unwrap().clone();
        registry.migrations.clear();
        fixture.service.save(&mut guard, registry).unwrap();
        drop(guard);
        {
            let _fault = fs::scoped_test_removal_injector(Arc::new(fs::RemovalFault(
                fs::RemovalFaultPoint::BeforeTopOpen,
            )));
            assert_eq!(fixture.list()[0].status, CollectionStatus::Trashed);
        }
        assert!(fixture.list().is_empty());
        assert!(!cache.exists());
        assert!(!fixture.service.root.path().join(&evidence).exists());
    }

    impl Fixture {
        fn trash(&self, file: &FileWorkspaceHandle) {
            crate::file_workspace::trash_entry(
                &self.state.pgn_path_authority,
                &self.state.workspace_mutation,
                &self.workspace,
                file,
                &CancellationToken::new(),
            )
            .unwrap();
        }

        fn restore(&self, file: &FileWorkspaceHandle) {
            crate::file_workspace::restore_entry(
                &self.state.pgn_path_authority,
                &self.state.workspace_mutation,
                &self.workspace,
                file,
                &CancellationToken::new(),
            )
            .unwrap();
        }

        pub fn new() -> Self {
            let directory = tempfile::tempdir().unwrap();
            let workspace_path = directory.path().join("library");
            std::fs::create_dir(&workspace_path).unwrap();
            let mut authority =
                PathAuthority::open(directory.path().join("authority.json"), vec![]).unwrap();
            let grant = authority
                .grant_dialog_operations(
                    &workspace_path,
                    "Library",
                    PathClass::BoundedDialogGrant,
                    vec![PathOperation::ReadPgn, PathOperation::WritePgn],
                    Duration::from_secs(60),
                    4,
                )
                .unwrap();
            let workspace = FileWorkspaceHandle::new(
                authority
                    .promote_dialog(
                        &grant,
                        PathClass::PersistentCustomRoot,
                        "Library",
                        vec![PathOperation::ReadPgn, PathOperation::WritePgn],
                    )
                    .unwrap()
                    .id,
            );
            let state = AppState::default();
            state.pgn_path_authority.install(authority).unwrap();
            let root = authority::ensure_app_owned_default_dir(
                &AppDataDir::for_test(&directory.path().join("app")),
                AppOwnedDefaultRoot::Collections,
            )
            .unwrap();
            let service = CollectionService::open(
                root,
                Arc::clone(&state.workspace_mutation),
                Arc::clone(&state.database_repository),
                Arc::clone(&state.search_cache),
                state.pgn_repository.clone(),
            );
            state
                .pgn_path_authority
                .install_collections(service)
                .unwrap();
            let service = state.pgn_path_authority.collections().unwrap().unwrap();
            Self {
                directory,
                state,
                workspace,
                service,
            }
        }

        pub fn create(
            &self,
            name: &str,
            body: &str,
            purpose: WorkspaceFileType,
        ) -> FileWorkspaceHandle {
            crate::file_workspace::create_workspace_file_blocking(
                self.workspace.clone(),
                self.workspace.clone(),
                name.into(),
                WorkspaceMetadata {
                    file_type: purpose,
                    tags: vec!["preserved".into()],
                },
                WorkspaceFileContent::Text { pgn: body.into() },
                &self.state.pgn_path_authority,
                &self.state.workspace_mutation,
                &self.state.pgn_repository,
                &CancellationToken::new(),
            )
            .unwrap()
            .handle
        }

        pub fn list(&self) -> Vec<CollectionDescriptor> {
            let token = CancellationToken::new();
            self.service
                .reconcile(&self.state.pgn_path_authority, &self.workspace, &token)
                .unwrap()
        }

        pub fn registered_ids(&self) -> Vec<String> {
            CollectionService::state(&mut self.service.lock(&CancellationToken::new()).unwrap())
                .unwrap()
                .records
                .iter()
                .map(|record| record.id.to_string())
                .collect()
        }

        pub fn path(&self, name: &str) -> PathBuf {
            self.directory
                .path()
                .join("library")
                .join(format!("{name}.pgn"))
        }

        fn rows(&self, collection: &CollectionDescriptor) -> Vec<NormalizedGame> {
            get_games_blocking(
                &self.state.pgn_path_authority,
                &self.state.database_repository,
                collection.database.clone().unwrap(),
                GameQuery::new(),
                &CancellationToken::new(),
            )
            .unwrap()
            .data
        }

        fn restart(&mut self) {
            self.state
                .pgn_path_authority
                .install(
                    PathAuthority::open(self.directory.path().join("authority.json"), vec![])
                        .unwrap(),
                )
                .unwrap();
            let root = authority::ensure_app_owned_default_dir(
                &AppDataDir::for_test(&self.directory.path().join("app")),
                AppOwnedDefaultRoot::Collections,
            )
            .unwrap();
            self.state
                .pgn_path_authority
                .install_collections(CollectionService::open(
                    root,
                    Arc::clone(&self.state.workspace_mutation),
                    Arc::new(DatabaseRepository::default()),
                    Arc::clone(&self.state.search_cache),
                    PgnRepository::default(),
                ))
                .unwrap();
            self.service = self
                .state
                .pgn_path_authority
                .collections()
                .unwrap()
                .unwrap();
        }

        pub fn account(&self, id: &str, provider: &str) {
            let mut guard = self.service.lock(&CancellationToken::new()).unwrap();
            let mut registry = CollectionService::state(&mut guard).unwrap().clone();
            registry
                .records
                .iter_mut()
                .find(|record| record.id.to_string() == id)
                .unwrap()
                .account = Some(AccountIdentity {
                provider: provider.into(),
                account: "player".into(),
            });
            self.service.save(&mut guard, registry).unwrap();
        }

        pub fn download_destination(&self) -> authority::PathRef {
            let root = self
                .service
                .root
                .ensure_child(OsStr::new("batches"))
                .unwrap();
            self.state
                .pgn_path_authority
                .with_mut(|authority| authority.collection_batch_destination(&root))
                .unwrap()
                .unwrap()
        }

        fn reference(&self, name: &str, body: &str) -> DatabaseHandle {
            let path = self.directory.path().join(format!("{name}.db3"));
            File::create(&path).unwrap();
            let handle = DatabaseHandle::new(
                self.state
                    .pgn_path_authority
                    .with_mut(|authority| {
                        authority.get_or_create_persistent_file(
                            &path,
                            name,
                            vec![
                                PathOperation::DatabaseRead,
                                PathOperation::DatabaseMutate,
                                PathOperation::DatabaseExport,
                                PathOperation::DatabaseCreate,
                            ],
                        )
                    })
                    .unwrap()
                    .unwrap()
                    .id,
            );
            let source = self.create(&format!("import-{name}"), body, WorkspaceFileType::Other);
            convert_pgn_blocking(
                &self.state.pgn_path_authority,
                &self.state.database_repository,
                &self.state.search_cache,
                vec![source],
                handle.clone(),
                None,
                self.app().handle().clone(),
                name.into(),
                None,
                format!("import-{name}"),
                &CancellationToken::new(),
            )
            .unwrap();
            handle
        }

        pub fn app(&self) -> tauri::App<tauri::test::MockRuntime> {
            use tauri::Manager;
            let app = tauri::test::mock_app();
            app.manage(self.state.clone());
            tauri_specta::Builder::<tauri::test::MockRuntime>::new()
                .events(tauri_specta::collect_events!(
                    crate::progress::ProgressEvent,
                    super::super::ConvertProgress
                ))
                .mount_events(&app);
            app
        }

        fn migration(
            &self,
            database: DatabaseHandle,
            source: Option<FileWorkspaceHandle>,
            choice: MigrationChoice,
        ) -> MigrationIntent {
            let token = CancellationToken::new();
            let target = resolve_database(
                &self.state.pgn_path_authority,
                &database,
                PathOperation::DatabaseRead,
            )
            .unwrap();
            let identity = self
                .state
                .database_repository
                .database_identity(&target)
                .unwrap();
            let source_revision = source.as_ref().map(|file| {
                self.state
                    .pgn_path_authority
                    .with_mut(|authority| {
                        authority
                            .resolve(file.path_ref(), PathOperation::ReadPgn, &[])
                            .unwrap()
                            .pgn_snapshot()
                            .map(|snapshot| pgn::revision_string(&snapshot))
                    })
                    .unwrap()
                    .unwrap()
            });
            let intent = MigrationIntent {
                id: Uuid::new_v4(),
                workspace: self.workspace.clone(),
                database,
                database_identity: target.identity(),
                database_revision: identity.data_revision,
                source,
                source_revision,
                choice,
                account: Some(AccountIdentity {
                    provider: "chesscom".into(),
                    account: "player".into(),
                }),
                destination_name: "migrated".into(),
                archive_identity: None,
                archive_ready: false,
                source_archive_identity: None,
                export_identity: None,
                destination: None,
                destination_identity: None,
                collection: None,
                original_collection: None,
            };
            self.service.update_intent(intent.clone(), &token).unwrap();
            intent
        }
    }

    struct EmptyMetadataRestoreCase {
        fixture: Fixture,
        collection: Uuid,
        archive: PathBuf,
        destination: DatabaseHandle,
        destination_path: PathBuf,
        expected_export: Vec<u8>,
    }

    impl EmptyMetadataRestoreCase {
        fn new() -> Self {
            let fixture = Fixture::new();
            let database = fixture.reference(
                "archive-source",
                &game(Some("789"), "c4 c5", "preserved archive annotation"),
            );
            let expected = fixture.create("expected-archive", "", WorkspaceFileType::Other);
            export_to_pgn_blocking(
                &fixture.state.pgn_path_authority,
                &fixture.state.database_repository,
                database.clone(),
                expected,
                &CancellationToken::new(),
            )
            .unwrap();
            let expected_export = std::fs::read(fixture.path("expected-archive")).unwrap();
            let intent = fixture.migration(database, None, MigrationChoice::Database);
            let archive = fixture
                .service
                .root
                .path()
                .join(format!("{}-original.db3", intent.id));
            let collection = fixture
                .service
                .migrate(
                    &fixture.state.pgn_path_authority,
                    &fixture.state.workspace_mutation,
                    intent,
                    &CancellationToken::new(),
                )
                .unwrap();
            let root_path = fixture.directory.path().join("databases");
            std::fs::create_dir(&root_path).unwrap();
            let root = fixture
                .state
                .pgn_path_authority
                .with_mut(|authority| {
                    authority.get_or_create_database_root(&root_path, "Databases", None)
                })
                .unwrap()
                .unwrap();
            // Use the same exclusive raw-file producer as create_workspace_database.
            let destination = crate::create_workspace_database_blocking(
                &fixture.state.pgn_path_authority,
                root,
                "restored.db3".into(),
            )
            .unwrap();
            Self {
                fixture,
                collection: Uuid::parse_str(&collection.id).unwrap(),
                archive,
                destination,
                destination_path: root_path.join("restored.db3"),
                expected_export,
            }
        }

        fn read_metadata(&self) {
            let before = empty_metadata_file_snapshot(&self.destination_path);
            let result = get_db_info_blocking(
                &self.fixture.state.pgn_path_authority,
                &self.fixture.state.database_repository,
                self.destination.clone(),
            );
            let error = match result {
                Err(error) => error,
                Ok(_) => panic!("ordinary metadata unexpectedly initialized the restore target"),
            };
            let after = empty_metadata_file_snapshot(&self.destination_path);
            println!("empty restore target metadata before={before} after={after} error={error:?}");
            assert!(
                matches!(&error, Error::InvalidInput(message) if message == "Database has not been initialized yet"),
                "ordinary metadata changed the not-initialized error: {error:?}"
            );
        }

        fn restore(&self) -> Result<(), Error> {
            self.fixture.service.restore_archive(
                &self.fixture.state.pgn_path_authority,
                self.collection,
                &self.destination,
                &CancellationToken::new(),
            )
        }
    }

    fn empty_metadata_file_snapshot(path: &std::path::Path) -> serde_json::Value {
        let bytes = std::fs::read(path).unwrap();
        let sidecars: Vec<_> = ["-wal", "-shm", "-journal", ".integrity"]
            .into_iter()
            .map(|suffix| {
                let mut sidecar = path.as_os_str().to_os_string();
                sidecar.push(suffix);
                let bytes = match std::fs::read(&sidecar) {
                    Ok(bytes) => Some(bytes),
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                    Err(error) => panic!("cannot inspect fixture sidecar {sidecar:?}: {error}"),
                };
                serde_json::json!({
                    "suffix": suffix,
                    "length": bytes.as_ref().map(Vec::len),
                    "header": bytes.as_ref().map(|bytes| &bytes[..bytes.len().min(32)]),
                })
            })
            .collect();
        serde_json::json!({
            "length": bytes.len(),
            "header": &bytes[..bytes.len().min(32)],
            "sidecars": sidecars,
        })
    }

    #[test]
    fn root_prerequisite_empty_metadata_preserves_restore_target_bytes() {
        let case = EmptyMetadataRestoreCase::new();
        let before = std::fs::read(&case.destination_path).unwrap();
        let snapshot_before = empty_metadata_file_snapshot(&case.destination_path);
        let target = resolve_database(
            &case.fixture.state.pgn_path_authority,
            &case.destination,
            PathOperation::DatabaseRead,
        )
        .unwrap();
        let identity_before = target.probe_current().unwrap().identity;
        let archive_before = std::fs::read(&case.archive).unwrap();
        assert!(
            before.is_empty(),
            "exclusive creation must produce raw empty bytes"
        );
        assert!(snapshot_before["sidecars"]
            .as_array()
            .unwrap()
            .iter()
            .all(|sidecar| sidecar["length"].is_null()));
        for _ in 0..3 {
            case.read_metadata();
            let after = std::fs::read(&case.destination_path).unwrap();
            assert_eq!(std::fs::read(&case.archive).unwrap(), archive_before);
            assert_eq!(
                after.len(),
                before.len(),
                "ordinary metadata changed the empty archive restore destination length"
            );
            assert_eq!(after, before, "ordinary metadata changed destination bytes");
            assert_eq!(target.probe_current().unwrap().identity, identity_before);
            assert_eq!(
                empty_metadata_file_snapshot(&case.destination_path),
                snapshot_before,
                "ordinary metadata created a SQLite or integrity sidecar"
            );
        }
    }

    #[test]
    fn root_prerequisite_empty_metadata_preserves_restore_target_for_same_handle_restore() {
        let mut case = EmptyMetadataRestoreCase::new();
        assert!(std::fs::read(&case.destination_path).unwrap().is_empty());
        let archive_before = std::fs::read(&case.archive).unwrap();
        for _ in 0..3 {
            case.read_metadata();
        }
        // Keep restoration separate so the byte-preservation failure cannot hide it.
        let restored = case.restore();
        println!("same-handle archive restoration after ordinary metadata: {restored:?}");
        assert_eq!(std::fs::read(&case.archive).unwrap(), archive_before);
        assert!(
            restored.is_ok(),
            "the same exclusively created handle must remain restorable after metadata: {restored:?}"
        );
        let exported = case
            .fixture
            .create("restored-export", "", WorkspaceFileType::Other);
        export_to_pgn_blocking(
            &case.fixture.state.pgn_path_authority,
            &case.fixture.state.database_repository,
            case.destination.clone(),
            exported,
            &CancellationToken::new(),
        )
        .unwrap();
        assert_eq!(
            std::fs::read(case.fixture.path("restored-export")).unwrap(),
            case.expected_export,
            "restoration must recover the actual archived games and annotations"
        );
        assert_eq!(std::fs::read(&case.archive).unwrap(), archive_before);
        let restored_before_retry = std::fs::read(&case.destination_path).unwrap();
        case.fixture.restart();
        for _ in 0..2 {
            case.restore().unwrap();
            assert_eq!(
                std::fs::read(&case.destination_path).unwrap(),
                restored_before_retry,
                "restart retry changed the completed restoration"
            );
            assert_eq!(std::fs::read(&case.archive).unwrap(), archive_before);
        }
    }

    #[test]
    fn root_prerequisite_empty_metadata_preserves_restore_target_nonempty_refusal() {
        let case = EmptyMetadataRestoreCase::new();
        let archive_before = std::fs::read(&case.archive).unwrap();
        let saved = b"existing destination bytes must survive archive restoration";
        std::fs::write(&case.destination_path, saved).unwrap();
        let result = case.restore();
        assert!(
            matches!(&result, Err(Error::Conflict(message)) if message == "archive restore requires an exclusively created empty database"),
            "nonempty destination must retain the restore guard: {result:?}"
        );
        assert_eq!(std::fs::read(&case.destination_path).unwrap(), saved);
        assert_eq!(std::fs::read(&case.archive).unwrap(), archive_before);
    }

    #[test]
    fn migration_database_choice_preserves_original_without_duplicate_active_versions() {
        let mut fixture = Fixture::new();
        let original = game(None, "e4 e5", "independent PGN version");
        let source = fixture.create("prior", &original, WorkspaceFileType::Tournament);
        let prior = fixture.list().pop().unwrap();
        let database = fixture.reference(
            "independent",
            &format!(
                "{}{}",
                game(None, "c4 c5", "database version"),
                game(None, "Nf3 Nf6", "second database game")
            ),
        );
        let original_before = fixture.directory.path().join("original-before.pgn");
        std::fs::copy(fixture.path("prior"), &original_before).unwrap();
        let before_listing = crate::file_workspace::collect_tree_entries(
            &fixture.state.pgn_path_authority,
            &fixture.workspace,
            &CancellationToken::new(),
        )
        .unwrap()
        .0;
        let before_metadata = selected_metadata(&before_listing.entries, &source).unwrap();
        let expected_database = fixture.create("expected-database", "", WorkspaceFileType::Other);
        export_to_pgn_blocking(
            &fixture.state.pgn_path_authority,
            &fixture.state.database_repository,
            database.clone(),
            expected_database,
            &CancellationToken::new(),
        )
        .unwrap();
        let intent = fixture.migration(database, Some(source.clone()), MigrationChoice::Database);
        let chosen = fixture
            .service
            .migrate(
                &fixture.state.pgn_path_authority,
                &fixture.state.workspace_mutation,
                intent.clone(),
                &CancellationToken::new(),
            )
            .unwrap();
        fixture.restart();
        let listed = fixture.list();
        assert_eq!(
            std::fs::read(fixture.path("prior")).unwrap(),
            original.as_bytes()
        );
        assert_eq!(
            listed
                .iter()
                .filter(|c| matches!(c.status, CollectionStatus::Ready))
                .count(),
            1,
            "Database choice left both prior and chosen versions actively indexed"
        );
        let preserved = listed.iter().find(|c| c.id == prior.id).unwrap();
        assert!(matches!(
            preserved.status,
            CollectionStatus::PreservedOriginal
        ));
        assert!(preserved.database.is_none());
        assert_eq!(fixture.rows(&chosen).len(), 2);
        assert!(fixture
            .rows(&chosen)
            .iter()
            .any(|row| row.moves.contains("c4")));
        assert!(fixture
            .rows(&chosen)
            .iter()
            .any(|row| row.moves.contains("Nf3")));
        let archive = fixture
            .service
            .root
            .path()
            .join(format!("{}-original.pgn", intent.id));
        assert_eq!(std::fs::read(archive).unwrap(), original.as_bytes());
        let after_listing = crate::file_workspace::collect_tree_entries(
            &fixture.state.pgn_path_authority,
            &fixture.workspace,
            &CancellationToken::new(),
        )
        .unwrap()
        .0;
        let after_metadata = selected_metadata(&after_listing.entries, &source).unwrap();
        assert_eq!(before_metadata.file_type, after_metadata.file_type);
        assert_eq!(before_metadata.tags, after_metadata.tags);
        let restored_path = fixture.directory.path().join("restored-original.db3");
        File::create(&restored_path).unwrap();
        let restored = DatabaseHandle::new(
            fixture
                .state
                .pgn_path_authority
                .with_mut(|authority| {
                    authority.get_or_create_persistent_file(
                        &restored_path,
                        "restored",
                        vec![
                            PathOperation::DatabaseCreate,
                            PathOperation::DatabaseRead,
                            PathOperation::DatabaseExport,
                        ],
                    )
                })
                .unwrap()
                .unwrap()
                .id,
        );
        fixture
            .service
            .restore_archive(
                &fixture.state.pgn_path_authority,
                Uuid::parse_str(&chosen.id).unwrap(),
                &restored,
                &CancellationToken::new(),
            )
            .unwrap();
        let restored_export = fixture.create("restored-export", "", WorkspaceFileType::Other);
        export_to_pgn_blocking(
            &fixture.state.pgn_path_authority,
            &fixture.state.database_repository,
            restored,
            restored_export,
            &CancellationToken::new(),
        )
        .unwrap();
        assert_eq!(
            std::fs::read(fixture.path("migrated")).unwrap(),
            std::fs::read(fixture.path("expected-database")).unwrap()
        );
        assert_eq!(
            std::fs::read(fixture.path("restored-export")).unwrap(),
            std::fs::read(fixture.path("expected-database")).unwrap()
        );
        if std::env::var_os("CHESSFABLE_LINKED_ARTIFACTS").is_some() {
            let disposition = fixture.directory.path().join("migration-disposition.json");
            let app = fixture.app();
            let query: GameQuery = serde_json::from_value(serde_json::json!({"position":{"fen":"rnbqkbnr/pppppppp/8/8/2P5/8/PP1PPPPP/RNBQKBNR b KQkq c3 0 1","type_":"exact"}})).unwrap();
            let searched = super::super::search::run_position_search(
                app.handle(),
                chosen.database.as_ref().unwrap(),
                query.clone(),
                "migration-original-search",
            )
            .unwrap();
            let refusal = match super::super::search::run_position_search(
                app.handle(),
                prior.database.as_ref().unwrap(),
                query,
                "migration-original-old-reference",
            ) {
                Err(error) => error,
                Ok(_) => panic!("preserved original reference search unexpectedly succeeded"),
            };
            let search_path = fixture.directory.path().join("migration-search.json");
            std::fs::write(&search_path, serde_json::to_vec(&searched).unwrap()).unwrap();
            std::fs::write(&disposition, serde_json::to_vec(&serde_json::json!({"collections":listed,"originalId":prior.id,"chosenId":chosen.id,"metadataBefore":before_metadata,"metadataAfter":after_metadata,"oldReferenceError":refusal})).unwrap()).unwrap();
            println!(
                "migration-original-artifacts {}",
                serde_json::json!({"migrationOriginal":fixture.path("prior"),"migrationOriginalBefore":original_before,"migrationChosen":fixture.path("migrated"),"migrationExpectedDatabase":fixture.path("expected-database"),"migrationArchiveExport":fixture.path("restored-export"),"migrationDisposition":disposition,"migrationSearch":search_path})
            );
            println!(
                "migration-original-artifact-directory {}",
                fixture.directory.keep().display()
            );
        }
    }

    #[tokio::test]
    async fn migration_original_waits_for_admitted_source_owner_and_preserves_winning_edit() {
        use tauri::Manager;
        let fixture = Fixture::new();
        let original = game(None, "e4 e5", "prior PGN");
        let source = fixture.create("prior", &original, WorkspaceFileType::Game);
        let prior = fixture.list().pop().unwrap();
        let database = fixture.reference("independent", &game(None, "c4 c5", "database"));
        let intent = fixture.migration(database, Some(source.clone()), MigrationChoice::Database);
        let (hook, entered, release) = pgn::BoundedHook::new();
        fixture
            .state
            .pgn_repository
            .set_edit_worker_hook(Some(hook))
            .unwrap();
        let app = fixture.app();
        let write = pgn::write_game(
            source,
            0,
            game(None, "Nf3 Nf6", "winning edit"),
            pgn::WriteExpectation::LinkedGame {
                stamp: pgn::game_stamp(original.as_bytes()),
                revision: prior.generation,
            },
            app.state::<AppState>(),
        );
        tokio::pin!(write);
        tokio::select! { result = &mut write => panic!("write did not enter its real publication barrier: {}", result.is_ok()), result = entered => result.unwrap() }
        let waiting = fixture
            .state
            .pgn_repository
            .observe_edit_lock_wait()
            .unwrap();
        let service = Arc::clone(&fixture.service);
        let authority = fixture.state.pgn_path_authority.clone();
        let mutation = Arc::clone(&fixture.state.workspace_mutation);
        let migration = tokio::task::spawn_blocking(move || {
            service.migrate(&authority, &mutation, intent, &CancellationToken::new())
        });
        tokio::pin!(migration);
        tokio::select! { result = &mut migration => panic!("migration bypassed the admitted original PGN edit owner: {}", result.unwrap().is_ok()), result = waiting => result.unwrap() }
        release.send(()).unwrap();
        let (write, migration) = tokio::join!(write, migration);
        write.unwrap();
        assert!(
            matches!(migration.unwrap(), Err(Error::StaleGame)),
            "migration failed to revalidate the winning source edit"
        );
        assert!(std::fs::read_to_string(fixture.path("prior"))
            .unwrap()
            .contains("Nf3"));
        assert_eq!(
            fixture
                .list()
                .iter()
                .filter(|c| c.status == CollectionStatus::Ready)
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn migration_original_rejects_captured_linked_save_and_old_index_after_activation() {
        use tauri::Manager;
        let mut fixture = Fixture::new();
        let original = game(None, "e4 e5", "original");
        let source = fixture.create("prior", &original, WorkspaceFileType::Game);
        let prior = fixture.list().pop().unwrap();
        let rows = fixture.rows(&prior);
        let id = Uuid::parse_str(&prior.id).unwrap();
        let mut rebind =
            pgn::PgnCapabilityRebind::new(fixture.state.pgn_path_authority.clone(), &source);
        rebind.capture_binding().unwrap();
        let resolved = fixture
            .state
            .pgn_path_authority
            .with_mut(|authority| {
                authority.resolve(source.path_ref(), PathOperation::WritePgn, &[])
            })
            .unwrap()
            .unwrap();
        let lease = fixture.state.operations.accept("write_game").unwrap();
        let database = fixture.reference("independent", &game(None, "c4 c5", "database"));
        let intent = fixture.migration(database, Some(source.clone()), MigrationChoice::Database);
        fixture
            .service
            .migrate(
                &fixture.state.pgn_path_authority,
                &fixture.state.workspace_mutation,
                intent,
                &CancellationToken::new(),
            )
            .unwrap();
        let result = pgn::write_game_core(
            lease,
            resolved,
            0,
            game(None, "d4 d5", "dirty linked edit"),
            pgn::WriteExpectation::LinkedGame {
                stamp: pgn::game_stamp(original.as_bytes()),
                revision: prior.generation.clone(),
            },
            fixture.state.pgn_repository.clone(),
            Some(rebind),
        )
        .await;
        assert!(
            matches!(result, Err(Error::StaleGame)),
            "captured linked save published through original retirement"
        );
        let app = fixture.app();
        let fresh = pgn::write_game(
            source.clone(),
            0,
            game(None, "d4 d5", "old linked save admitted after activation"),
            pgn::WriteExpectation::LinkedGame {
                stamp: pgn::game_stamp(original.as_bytes()),
                revision: prior.generation.clone(),
            },
            app.state::<AppState>(),
        )
        .await;
        assert!(
            matches!(fresh, Err(Error::StaleGame)),
            "a newly admitted old linked save edited the preserved original"
        );
        drop(app);
        assert!(
            fixture
                .service
                .resolve_game(
                    &fixture.state.pgn_path_authority,
                    prior.database.as_ref().unwrap(),
                    rows[0].id,
                    rows[0].linked.as_ref(),
                    &CancellationToken::new()
                )
                .is_err(),
            "old linked result still opened as an active collection"
        );
        assert!(
            fixture
                .service
                .validate_result(
                    &fixture.state.pgn_path_authority,
                    prior.database.as_ref().unwrap(),
                    &Some(prior.generation)
                )
                .is_err(),
            "admitted old search results survived original retirement"
        );
        assert!(
            get_games_blocking(
                &fixture.state.pgn_path_authority,
                &fixture.state.database_repository,
                prior.database.clone().unwrap(),
                GameQuery::new(),
                &CancellationToken::new()
            )
            .is_err(),
            "old reference index remained searchable"
        );
        let descriptor = fixture
            .service
            .metadata_for_database(
                &fixture.state.pgn_path_authority,
                prior.database.as_ref().unwrap(),
                &CancellationToken::new(),
            )
            .unwrap()
            .unwrap();
        assert!(
            descriptor.status == CollectionStatus::PreservedOriginal
                && descriptor.database.is_none()
        );
        let record = fixture
            .service
            .record(id, &CancellationToken::new())
            .unwrap();
        let target = fixture.service.target(&record).unwrap();
        fixture
            .state
            .database_repository
            .close_and_invalidate(&target)
            .unwrap();
        std::fs::remove_file(target.path()).unwrap();
        fixture.restart();
        let preserved = fixture
            .list()
            .into_iter()
            .find(|c| c.id == prior.id)
            .unwrap();
        assert!(
            preserved.status == CollectionStatus::PreservedOriginal && preserved.database.is_none()
        );
        assert!(
            !target.path().exists(),
            "reconciliation recreated the preserved original's disposable cache"
        );
        crate::file_workspace::rename_workspace_file_blocking(
            fixture.workspace.clone(),
            source,
            "renamed-original".into(),
            WorkspaceMetadata {
                file_type: WorkspaceFileType::Game,
                tags: vec!["preserved".into()],
            },
            &fixture.state.pgn_path_authority,
            &fixture.state.workspace_mutation,
            &CancellationToken::new(),
        )
        .unwrap();
        fixture.restart();
        let renamed = fixture
            .list()
            .into_iter()
            .find(|c| c.id == prior.id)
            .unwrap();
        assert_eq!(renamed.name, "renamed-original.pgn");
        assert_eq!(renamed.status, CollectionStatus::PreservedOriginal);
        assert_eq!(
            std::fs::read(fixture.path("renamed-original")).unwrap(),
            original.as_bytes()
        );
    }

    #[test]
    fn migration_original_late_reconciliation_and_pre_activation_refusal_preserve_ownership() {
        struct RefuseRename;
        impl fs::AtomicWriterInjector for RefuseRename {
            fn inject(&self, point: fs::AtomicFileFaultPoint) -> std::io::Result<()> {
                if point == fs::AtomicFileFaultPoint::Rename {
                    Err(std::io::Error::other(
                        "migration original preactivation storage refusal",
                    ))
                } else {
                    Ok(())
                }
            }
        }
        for indexed in [false, true] {
            let mut fixture = Fixture::new();
            let original = game(None, "e4 e5", "prior PGN");
            let source = fixture.create("prior", &original, WorkspaceFileType::Game);
            if indexed {
                fixture.list();
            }
            let database = fixture.reference("independent", &game(None, "c4 c5", "database"));
            let intent = fixture.migration(database, Some(source), MigrationChoice::Database);
            let cancelled = CancellationToken::new();
            cancelled.cancel();
            assert!(matches!(
                fixture.service.migrate(
                    &fixture.state.pgn_path_authority,
                    &fixture.state.workspace_mutation,
                    intent.clone(),
                    &cancelled
                ),
                Err(Error::Cancellation)
            ));
            assert_eq!(
                CollectionService::state(
                    &mut fixture.service.lock(&CancellationToken::new()).unwrap()
                )
                .unwrap()
                .records
                .len(),
                usize::from(indexed)
            );
            let fault = fs::install_test_atomic_file_injector(Arc::new(RefuseRename));
            assert!(fixture
                .service
                .migrate(
                    &fixture.state.pgn_path_authority,
                    &fixture.state.workspace_mutation,
                    intent.clone(),
                    &CancellationToken::new()
                )
                .is_err());
            drop(fault);
            assert_eq!(
                CollectionService::state(
                    &mut fixture.service.lock(&CancellationToken::new()).unwrap()
                )
                .unwrap()
                .records
                .len(),
                usize::from(indexed)
            );
            let chosen = fixture
                .service
                .migrate(
                    &fixture.state.pgn_path_authority,
                    &fixture.state.workspace_mutation,
                    intent.clone(),
                    &CancellationToken::new(),
                )
                .unwrap();
            let saved = CollectionService::state(
                &mut fixture.service.lock(&CancellationToken::new()).unwrap(),
            )
            .unwrap()
            .migrations
            .iter()
            .find(|saved| saved.id == intent.id)
            .unwrap()
            .clone();
            fixture.restart();
            let repeated = fixture
                .service
                .migrate(
                    &fixture.state.pgn_path_authority,
                    &fixture.state.workspace_mutation,
                    saved,
                    &CancellationToken::new(),
                )
                .unwrap();
            assert_eq!(chosen.id, repeated.id);
            let listed = fixture.list();
            assert_eq!(
                listed
                    .iter()
                    .filter(|c| c.status == CollectionStatus::Ready)
                    .count(),
                1
            );
            assert_eq!(
                listed
                    .iter()
                    .filter(|c| c.status == CollectionStatus::PreservedOriginal)
                    .count(),
                1
            );
            assert_eq!(
                std::fs::read(fixture.path("prior")).unwrap(),
                original.as_bytes()
            );
        }
    }

    #[test]
    fn migration_original_refuses_existing_account_or_pending_ownership() {
        for account in [false, true] {
            let mut fixture = Fixture::new();
            let original = game(None, "e4 e5", "original");
            let source = fixture.create("prior", &original, WorkspaceFileType::Game);
            let prior = fixture.list().pop().unwrap();
            if account {
                fixture.account(&prior.id, "chesscom");
            } else {
                let incoming = fixture.create(
                    "pending",
                    &game(None, "d4 d5", "pending input"),
                    WorkspaceFileType::Other,
                );
                fixture
                    .service
                    .stage_batch(
                        &fixture.state.pgn_path_authority,
                        Uuid::parse_str(&prior.id).unwrap(),
                        incoming,
                        &CancellationToken::new(),
                    )
                    .unwrap();
            }
            let before = fixture
                .service
                .record(
                    Uuid::parse_str(&prior.id).unwrap(),
                    &CancellationToken::new(),
                )
                .unwrap();
            let database = fixture.reference("independent", &game(None, "c4 c5", "database"));
            let intent = fixture.migration(database, Some(source), MigrationChoice::Database);
            assert!(matches!(
                fixture.service.migrate(
                    &fixture.state.pgn_path_authority,
                    &fixture.state.workspace_mutation,
                    intent.clone(),
                    &CancellationToken::new()
                ),
                Err(Error::Conflict(_))
            ));
            assert!(!fixture.service.root.path().join(format!("{}-original.db3", intent.id)).exists(), "incompatible original ownership was discovered only after creating recovery artifacts");
            fixture.restart();
            let after = fixture
                .service
                .record(
                    Uuid::parse_str(&prior.id).unwrap(),
                    &CancellationToken::new(),
                )
                .unwrap();
            assert!(
                before.account == after.account
                    && before.pending == after.pending
                    && before.coverage_cursor_ms == after.coverage_cursor_ms
            );
            assert_eq!(
                fixture
                    .list()
                    .iter()
                    .filter(|c| c.status == CollectionStatus::Ready)
                    .count(),
                1
            );
            assert_eq!(
                std::fs::read(fixture.path("prior")).unwrap(),
                original.as_bytes()
            );
        }
    }

    #[tokio::test]
    async fn migration_original_pre_activation_export_cannot_become_a_second_active_version() {
        use tauri::Manager;
        struct RefuseActivation {
            registry: PathBuf,
            intent: Uuid,
        }
        impl fs::AtomicWriterInjector for RefuseActivation {
            fn inject(&self, point: fs::AtomicFileFaultPoint) -> std::io::Result<()> {
                if point == fs::AtomicFileFaultPoint::Rename {
                    let current: Registry = serde_json::from_slice(&std::fs::read(&self.registry)?)
                        .map_err(std::io::Error::other)?;
                    if current.migrations.iter().any(|intent| {
                        intent.id == self.intent
                            && intent.destination.is_some()
                            && intent.collection.is_none()
                    }) {
                        return Err(std::io::Error::other(
                            "refuse after real export and before activation",
                        ));
                    }
                }
                Ok(())
            }
        }
        let mut fixture = Fixture::new();
        let original = game(None, "e4 e5", "prior PGN");
        let source = fixture.create("prior", &original, WorkspaceFileType::Game);
        let prior = fixture.list().pop().unwrap();
        let database = fixture.reference("independent", &game(None, "c4 c5", "database"));
        let intent = fixture.migration(database, Some(source), MigrationChoice::Database);
        let fault = fs::install_test_atomic_file_injector(Arc::new(RefuseActivation {
            registry: fixture.service.root.path().join(REGISTRY),
            intent: intent.id,
        }));
        assert!(fixture
            .service
            .migrate(
                &fixture.state.pgn_path_authority,
                &fixture.state.workspace_mutation,
                intent.clone(),
                &CancellationToken::new()
            )
            .is_err());
        drop(fault);
        assert!(
            fixture.path("migrated").exists(),
            "fixture did not reach a real prepared export"
        );
        fixture.restart();
        let pending = fixture.list();
        assert_eq!(
            pending
                .iter()
                .filter(|c| c.status == CollectionStatus::Ready)
                .count(),
            1,
            "preactivation export became a second active version before migration committed"
        );
        assert!(pending
            .iter()
            .any(|c| c.id == prior.id && c.status == CollectionStatus::Ready));
        assert_eq!(
            std::fs::read(fixture.path("prior")).unwrap(),
            original.as_bytes()
        );
        let prepared = pending.iter().find(|entry| entry.id != prior.id).unwrap();
        let prepared_id = prepared.id.clone();
        assert_eq!(prepared.status, CollectionStatus::Retired);
        let exported = std::fs::read(fixture.path("migrated")).unwrap();
        let app = fixture.app();
        let attempted = pgn::write_game(
            prepared.file.clone(),
            1,
            game(None, "d4 d5", "edit before migration activation"),
            pgn::WriteExpectation::Append,
            app.state::<AppState>(),
        )
        .await;
        assert!(
            matches!(attempted, Err(Error::StaleGame)),
            "a prepared migration export admitted a source mutation before activation"
        );
        drop(app);
        assert_eq!(std::fs::read(fixture.path("migrated")).unwrap(), exported);
        assert_eq!(
            std::fs::read(fixture.path("prior")).unwrap(),
            original.as_bytes()
        );
        let saved =
            CollectionService::state(&mut fixture.service.lock(&CancellationToken::new()).unwrap())
                .unwrap()
                .migrations
                .iter()
                .find(|saved| saved.id == intent.id)
                .unwrap()
                .clone();
        let activated = fixture
            .service
            .migrate(
                &fixture.state.pgn_path_authority,
                &fixture.state.workspace_mutation,
                saved,
                &CancellationToken::new(),
            )
            .unwrap();
        assert_eq!(
            activated.id, prepared_id,
            "retry replaced the prepared collection identity"
        );
        assert_eq!(std::fs::read(fixture.path("migrated")).unwrap(), exported);
        assert_eq!(
            fixture
                .list()
                .iter()
                .filter(|c| c.status == CollectionStatus::Ready)
                .count(),
            1
        );
    }

    async fn reselect_after_legacy_match(
        fixture: &mut Fixture,
        selected_body: &str,
        drop_cache: bool,
    ) -> (CollectionDescriptor, FileWorkspaceHandle) {
        use tauri::Manager;
        let original = game(None, "e4 e5", "legacy annotation");
        fixture.create("source", &original, WorkspaceFileType::Game);
        let collection = fixture.list().pop().unwrap();
        let id = Uuid::parse_str(&collection.id).unwrap();
        fixture.account(&collection.id, "chesscom");
        let incoming = fixture.create(
            "incoming",
            &game(Some("123"), "e4 e5", "provider annotation"),
            WorkspaceFileType::Other,
        );
        let first = Arc::clone(&fixture.service)
            .append_batch(
                fixture.state.pgn_path_authority.clone(),
                id,
                incoming.clone(),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(first.appended, 0);
        assert!(first.committed && first.index_ready && first.durability_confirmed);
        assert_eq!(
            std::fs::read(fixture.path("source")).unwrap(),
            original.as_bytes()
        );
        let before = fixture
            .service
            .record(id, &CancellationToken::new())
            .unwrap();
        let selected = fixture.create("selected", selected_body, WorkspaceFileType::Other);
        let app = fixture.app();
        let selected_collection = reselect_linked_collection(
            collection.id,
            fixture.workspace.clone(),
            selected,
            app.state::<AppState>(),
        )
        .await
        .unwrap();
        drop(app);
        fixture.restart();
        let current = fixture
            .service
            .record(id, &CancellationToken::new())
            .unwrap();
        assert_eq!(current.source_epoch, before.source_epoch + 1);
        assert_eq!(current.file, selected_collection.file);
        if drop_cache {
            let target = fixture.service.target(&current).unwrap();
            fixture
                .service
                .repository
                .close_and_invalidate(&target)
                .unwrap();
            fixture
                .state
                .database_repository
                .close_and_invalidate(&target)
                .unwrap();
            std::fs::remove_file(target.path()).unwrap();
        }
        assert_eq!(
            std::fs::read(fixture.path("source")).unwrap(),
            original.as_bytes()
        );
        assert_eq!(
            std::fs::read(fixture.path("selected")).unwrap(),
            selected_body.as_bytes()
        );
        (selected_collection, incoming)
    }

    #[tokio::test]
    async fn native_repair_reselection_explicit_identity_survives_restart_and_cache_loss() {
        for drop_cache in [false, true] {
            let mut fixture = Fixture::new();
            let selected_body = game(Some("123"), "e4 e5", "selected annotation")
                .replace("Collection fixture", "Selected explicit identity");
            let (collection, incoming) =
                reselect_after_legacy_match(&mut fixture, &selected_body, drop_cache).await;
            let id = Uuid::parse_str(&collection.id).unwrap();
            let result = Arc::clone(&fixture.service)
                .append_batch(
                    fixture.state.pgn_path_authority.clone(),
                    id,
                    incoming,
                    CancellationToken::new(),
                )
                .await;
            // Assert preservation before checking the outcome so the original red also proves it.
            assert_eq!(
                std::fs::read(fixture.path("source")).unwrap(),
                game(None, "e4 e5", "legacy annotation").as_bytes()
            );
            assert_eq!(
                std::fs::read(fixture.path("selected")).unwrap(),
                selected_body.as_bytes()
            );
            assert_eq!(
                std::fs::read(fixture.path("incoming")).unwrap(),
                game(Some("123"), "e4 e5", "provider annotation").as_bytes()
            );
            assert!(result.is_ok(), "current explicit ID123 was blocked by obsolete legacy binding, cache removed={drop_cache}: {:?}", result.err());
            let outcome = result.unwrap();
            assert_eq!(
                outcome.appended, 0,
                "explicit current identity was appended twice"
            );
            assert!(outcome.committed && outcome.index_ready && outcome.durability_confirmed);
            let current = fixture
                .service
                .describe(
                    &fixture.state.pgn_path_authority,
                    &fixture
                        .service
                        .record(id, &CancellationToken::new())
                        .unwrap(),
                    &CancellationToken::new(),
                )
                .unwrap();
            let rows = fixture.rows(&current);
            assert_eq!(rows.len(), 1);
            assert_eq!(rows[0].event, "Selected explicit identity");
            assert_eq!(
                rows[0].linked.as_ref().unwrap().generation,
                current.generation
            );
            assert!(fixture
                .service
                .record(id, &CancellationToken::new())
                .unwrap()
                .pending
                .is_none());
        }
    }

    #[tokio::test]
    async fn native_repair_reselection_retains_legacy_and_current_identity_conflicts() {
        let matching = game(Some("123"), "e4 e5", "selected known identity");
        let conflicting = game(Some("123"), "d4 d5", "conflicting known identity");
        for (case, selected_body, incoming_moves) in [
            (
                "new ID-less binding",
                game(None, "e4 e5", "legacy annotation"),
                "e4 e5",
            ),
            (
                "ambiguous explicit identity",
                format!("{matching}{matching}"),
                "e4 e5",
            ),
            (
                "conflicting explicit identity",
                conflicting.clone(),
                "e4 e5",
            ),
            (
                "current identity conflicts with durable semantics",
                conflicting.clone(),
                "d4 d5",
            ),
            (
                "mixed conflicting identity",
                format!("{matching}{conflicting}"),
                "e4 e5",
            ),
            (
                "distinct known identity",
                game(Some("456"), "e4 e5", "distinct known game"),
                "e4 e5",
            ),
        ] {
            let mut fixture = Fixture::new();
            let (collection, _) =
                reselect_after_legacy_match(&mut fixture, &selected_body, true).await;
            let id = Uuid::parse_str(&collection.id).unwrap();
            let incoming_body = game(Some("123"), incoming_moves, "overlap annotation");
            let incoming = fixture.create("overlap", &incoming_body, WorkspaceFileType::Other);
            let result = Arc::clone(&fixture.service)
                .append_batch(
                    fixture.state.pgn_path_authority.clone(),
                    id,
                    incoming,
                    CancellationToken::new(),
                )
                .await;
            assert!(
                matches!(result, Err(Error::Conflict(_))),
                "{case} silently reused obsolete legacy identity"
            );
            assert_eq!(
                std::fs::read(fixture.path("source")).unwrap(),
                game(None, "e4 e5", "legacy annotation").as_bytes(),
                "{case}"
            );
            assert_eq!(
                std::fs::read(fixture.path("selected")).unwrap(),
                selected_body.as_bytes(),
                "{case}"
            );
            assert_eq!(
                std::fs::read(fixture.path("incoming")).unwrap(),
                game(Some("123"), "e4 e5", "provider annotation").as_bytes(),
                "{case}"
            );
            assert_eq!(
                std::fs::read(fixture.path("overlap")).unwrap(),
                incoming_body.as_bytes(),
                "{case}"
            );
            let pending = fixture
                .service
                .record(id, &CancellationToken::new())
                .unwrap()
                .pending
                .unwrap();
            let staged = fixture
                .service
                .root
                .path()
                .join(format!("{}-batch.pgn", pending.id));
            assert_eq!(
                std::fs::read(staged).unwrap(),
                incoming_body.as_bytes(),
                "pending input lost for {case}"
            );
        }
    }

    #[tokio::test]
    async fn native_repair_legacy_assignment_survives_restart_cache_loss_and_annotations() {
        let mut fixture = Fixture::new();
        let original = game(None, "e4 e5", "legacy annotation");
        fixture.create("source", &original, WorkspaceFileType::Game);
        let collection = fixture.list().pop().unwrap();
        let id = Uuid::parse_str(&collection.id).unwrap();
        fixture.account(&collection.id, "chesscom");
        let first = fixture.create(
            "first",
            &game(Some("123"), "e4 e5", "provider"),
            WorkspaceFileType::Other,
        );
        let outcome = Arc::clone(&fixture.service)
            .append_batch(
                fixture.state.pgn_path_authority.clone(),
                id,
                first,
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(outcome.appended, 0);
        assert!(outcome.committed && outcome.index_ready);
        assert_eq!(
            std::fs::read(fixture.path("source")).unwrap(),
            original.as_bytes()
        );
        fixture.restart();
        let record = fixture
            .service
            .record(id, &CancellationToken::new())
            .unwrap();
        let target = fixture.service.target(&record).unwrap();
        fixture
            .state
            .database_repository
            .close_and_invalidate(&target)
            .unwrap();
        std::fs::remove_file(target.path()).unwrap();
        let annotated = original.replace("legacy annotation", "user changed annotation");
        std::fs::write(fixture.path("source"), &annotated).unwrap();
        fixture.list();
        let second = fixture.create(
            "second",
            &game(Some("456"), "e4 e5", "different known game"),
            WorkspaceFileType::Other,
        );
        let outcome = Arc::clone(&fixture.service)
            .append_batch(
                fixture.state.pgn_path_authority.clone(),
                id,
                second,
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(
            outcome.appended, 1,
            "a second known ID reused the assigned legacy occurrence"
        );
        let bytes = std::fs::read(fixture.path("source")).unwrap();
        assert!(bytes.starts_with(annotated.as_bytes()));
        assert!(String::from_utf8_lossy(&bytes).contains("/456"));
        assert_eq!(fixture.rows(&fixture.list().pop().unwrap()).len(), 2);
    }

    #[test]
    fn native_repair_conversion_refuses_verified_linked_alias_without_cache() {
        let fixture = Fixture::new();
        let source = fixture.create(
            "source",
            &game(None, "e4 e5", "library"),
            WorkspaceFileType::Game,
        );
        let collection = fixture.list().pop().unwrap();
        let record = fixture
            .service
            .record(
                Uuid::parse_str(&collection.id).unwrap(),
                &CancellationToken::new(),
            )
            .unwrap();
        let cache = fixture.service.target(&record).unwrap();
        fixture
            .state
            .database_repository
            .close_and_invalidate(&cache)
            .unwrap();
        std::fs::remove_file(cache.path()).unwrap();
        let alias = FileWorkspaceHandle::new(
            fixture
                .state
                .pgn_path_authority
                .with_mut(|authority| {
                    authority.grant_dialog_operations(
                        &fixture.path("source"),
                        "Fresh picker",
                        PathClass::BoundedDialogGrant,
                        vec![PathOperation::ReadPgn],
                        Duration::from_secs(60),
                        4,
                    )
                })
                .unwrap()
                .unwrap(),
        );
        let external = fixture.create(
            "external",
            &game(None, "d4 d5", "external"),
            WorkspaceFileType::Other,
        );
        let target = fixture.reference("reference", &game(None, "Nf3 Nf6", "existing"));
        let result = convert_pgn_blocking(
            &fixture.state.pgn_path_authority,
            &fixture.state.database_repository,
            &fixture.state.search_cache,
            vec![external, alias],
            target.clone(),
            None,
            fixture.app().handle().clone(),
            "reference".into(),
            None,
            "native-repair-mixed".into(),
            &CancellationToken::new(),
        );
        assert!(
            matches!(result, Err(Error::Conflict(_))),
            "mixed conversion admitted linked source {source:?}"
        );
        let target = resolve_database(
            &fixture.state.pgn_path_authority,
            &target,
            PathOperation::DatabaseRead,
        )
        .unwrap();
        let count: i64 = games::table
            .count()
            .get_result(
                &mut *fixture
                    .state
                    .database_repository
                    .connection(&target, None)
                    .unwrap(),
            )
            .unwrap();
        assert_eq!(
            count, 1,
            "mixed-source refusal changed the reference database"
        );
    }

    #[test]
    fn native_repair_second_migration_preserves_first_retirement_and_archive() {
        let fixture = Fixture::new();
        let source = fixture.create(
            "source",
            &game(None, "e4 e5", "source"),
            WorkspaceFileType::Game,
        );
        let automatic = fixture.list().pop().unwrap();
        let first = fixture.reference("first-db", &game(None, "d4 d5", "first"));
        let intent = fixture.migration(first.clone(), Some(source.clone()), MigrationChoice::Pgn);
        let first_intent = intent.clone();
        let collection = fixture
            .service
            .migrate(
                &fixture.state.pgn_path_authority,
                &fixture.state.workspace_mutation,
                intent,
                &CancellationToken::new(),
            )
            .unwrap();
        assert_eq!(
            collection.id, automatic.id,
            "first pairing replaced the automatically indexed collection identity"
        );
        let second = fixture.reference("second-db", &game(None, "Nf3 Nf6", "second"));
        let intent = fixture.migration(second, Some(source), MigrationChoice::Pgn);
        let archive = format!("{}-original.db3", intent.id);
        let result = fixture.service.migrate(
            &fixture.state.pgn_path_authority,
            &fixture.state.workspace_mutation,
            intent,
            &CancellationToken::new(),
        );
        assert!(
            matches!(result, Err(Error::Conflict(_))),
            "second migration replaced the first retirement"
        );
        assert!(
            entry_identity_at(
                fixture.service.root.descriptor(),
                OsStr::new(&archive),
                false
            )
            .is_err_and(|error| error.is_missing_entry()),
            "refused migration created an archive"
        );
        assert!(fixture
            .service
            .guard_database(&first, PathOperation::DatabaseMutate)
            .is_err());
        let record = fixture
            .service
            .record(
                Uuid::parse_str(&collection.id).unwrap(),
                &CancellationToken::new(),
            )
            .unwrap();
        assert_eq!(record.retired_database, Some(first));
        let completed =
            CollectionService::state(&mut fixture.service.lock(&CancellationToken::new()).unwrap())
                .unwrap()
                .migrations
                .iter()
                .find(|intent| intent.id == first_intent.id)
                .unwrap()
                .clone();
        assert_eq!(
            fixture
                .service
                .migrate(
                    &fixture.state.pgn_path_authority,
                    &fixture.state.workspace_mutation,
                    completed,
                    &CancellationToken::new()
                )
                .unwrap()
                .id,
            collection.id
        );
    }

    #[test]
    fn native_repair_current_record_keeps_newer_registry_state() {
        let fixture = Fixture::new();
        fixture.create(
            "source",
            &game(None, "e4 e5", "original"),
            WorkspaceFileType::Game,
        );
        let collection = fixture.list().pop().unwrap();
        let id = Uuid::parse_str(&collection.id).unwrap();
        let replacement = fixture.path("replacement");
        std::fs::write(&replacement, game(None, "d4 d5", "external replacement")).unwrap();
        std::fs::rename(&replacement, fixture.path("source")).unwrap();
        let service = Arc::clone(&fixture.service);
        crate::file_workspace::set_workspace_listing_pre_register_hook(Some(Box::new(move || {
            let token = CancellationToken::new();
            let mut guard = service.lock(&token).unwrap();
            let mut registry = CollectionService::state(&mut guard).unwrap().clone();
            let current = registry
                .records
                .iter_mut()
                .find(|record| record.id == id)
                .unwrap();
            current.coverage_cursor_ms = Some(123456);
            current.account = Some(AccountIdentity {
                provider: "chesscom".into(),
                account: "newer".into(),
            });
            service.save(&mut guard, registry).unwrap();
        })));
        let result = fixture.service.current_record(
            &fixture.state.pgn_path_authority,
            id,
            &CancellationToken::new(),
        );
        crate::file_workspace::set_workspace_listing_pre_register_hook(None);
        let record = result.unwrap();
        assert_eq!(
            record.coverage_cursor_ms,
            Some(123456),
            "source reconciliation overwrote newer coverage"
        );
        assert_eq!(
            record.account.as_ref().unwrap().account,
            "newer",
            "source reconciliation overwrote newer account"
        );
        assert_eq!(
            fixture
                .service
                .record(id, &CancellationToken::new())
                .unwrap()
                .coverage_cursor_ms,
            Some(123456)
        );
    }

    #[tokio::test]
    async fn nested_collection_discovery_and_replacement_rebind_use_relative_locator() {
        use tauri::Manager;
        let mut fixture = Fixture::new();
        let root_body = game(None, "e4 e5", "same basename at root");
        let root_file = fixture.create("games", &root_body, WorkspaceFileType::Game);
        let app = fixture.app();
        let nested = crate::file_workspace::create_workspace_directory(
            fixture.workspace.clone(),
            fixture.workspace.clone(),
            "nested".into(),
            app.state::<AppState>(),
        )
        .await
        .unwrap();
        let deep = crate::file_workspace::create_workspace_directory(
            fixture.workspace.clone(),
            nested.handle,
            "deep".into(),
            app.state::<AppState>(),
        )
        .await
        .unwrap();
        let original = game(None, "d4 d5", "nested source");
        let nested_file = crate::file_workspace::create_workspace_file_blocking(
            fixture.workspace.clone(),
            deep.handle,
            "games".into(),
            WorkspaceMetadata {
                file_type: WorkspaceFileType::Tournament,
                tags: vec!["nested annotation".into()],
            },
            WorkspaceFileContent::Text {
                pgn: original.clone(),
            },
            &fixture.state.pgn_path_authority,
            &fixture.state.workspace_mutation,
            &fixture.state.pgn_repository,
            &CancellationToken::new(),
        )
        .unwrap()
        .handle;
        drop(app);
        let source = fixture
            .directory
            .path()
            .join("library/nested/deep/games.pgn");
        let sidecar = source.with_file_name(
            authority::workspace_sidecar_leaf(source.file_name().unwrap()).unwrap(),
        );
        let metadata = std::fs::read(&sidecar).unwrap();
        let listed = fixture.list();
        assert_eq!(listed.len(), 2);
        let collection = listed
            .iter()
            .find(|entry| entry.file == nested_file)
            .unwrap();
        let root = listed.iter().find(|entry| entry.file == root_file).unwrap();
        assert_ne!(collection.id, root.id);
        assert_eq!(collection.status, CollectionStatus::Ready);
        assert!(fixture.rows(collection)[0].moves.contains("d4"));
        let id = Uuid::parse_str(&collection.id).unwrap();
        let held_source = File::open(&source).unwrap();
        let original_identity = authority::opened_file_identity(&held_source).unwrap();
        let replacement = game(None, "c4 c5", "replacement at the nested locator");
        let temporary = fixture.directory.path().join("replacement.pgn");
        std::fs::write(&temporary, &replacement).unwrap();
        std::fs::rename(temporary, &source).unwrap();
        // Exercise current_record's fallback before reconciliation can renew the source handle.
        let rebound = fixture
            .service
            .current_record(
                &fixture.state.pgn_path_authority,
                id,
                &CancellationToken::new(),
            )
            .unwrap();
        assert_eq!(rebound.id, id);
        assert_eq!(
            rebound.locator,
            vec![
                OsString::from("nested"),
                OsString::from("deep"),
                OsString::from("games.pgn")
            ]
        );
        assert_ne!(rebound.identity, original_identity);
        let current = fixture
            .service
            .describe(
                &fixture.state.pgn_path_authority,
                &rebound,
                &CancellationToken::new(),
            )
            .unwrap();
        assert_eq!(current.status, CollectionStatus::Ready);
        assert_eq!(fixture.rows(&current).len(), 1);
        assert!(fixture.rows(&current)[0].moves.contains("c4"));
        fixture.restart();
        for _ in 0..2 {
            let current = fixture.list();
            assert_eq!(current.len(), 2);
            assert!(
                current
                    .iter()
                    .any(|entry| entry.id == id.to_string()
                        && entry.status == CollectionStatus::Ready)
            );
            assert!(current
                .iter()
                .any(|entry| entry.id == root.id && entry.file == root_file));
            assert_eq!(std::fs::read(&source).unwrap(), replacement.as_bytes());
            assert_eq!(std::fs::read(&sidecar).unwrap(), metadata);
            assert_eq!(
                std::fs::read(fixture.path("games")).unwrap(),
                root_body.as_bytes()
            );
        }
    }

    #[tokio::test]
    async fn native_repair_reselection_waits_for_admitted_pgn_publication() {
        use tauri::Manager;
        let fixture = Fixture::new();
        let original = game(None, "e4 e5", "original");
        let old = fixture.create("source", &original, WorkspaceFileType::Game);
        let collection = fixture.list().pop().unwrap();
        let selected = fixture.create(
            "selected",
            &game(None, "d4 d5", "selected"),
            WorkspaceFileType::Other,
        );
        let (hook, entered, release) = pgn::BoundedHook::new();
        fixture
            .state
            .pgn_repository
            .set_edit_worker_hook(Some(hook))
            .unwrap();
        let app = fixture.app();
        let write = pgn::write_game(
            old,
            0,
            game(None, "Nf3 Nf6", "admitted write"),
            pgn::WriteExpectation::LinkedGame {
                stamp: pgn::game_stamp(original.as_bytes()),
                revision: collection.generation,
            },
            app.state::<AppState>(),
        );
        tokio::pin!(write);
        tokio::select! { result = &mut write => panic!("write did not enter publication barrier: {}", result.is_ok()), result = entered => result.unwrap() }
        let waiting = fixture
            .state
            .pgn_repository
            .observe_edit_lock_wait()
            .unwrap();
        let mut acquired = fixture
            .state
            .pgn_repository
            .observe_edit_lock_acquired()
            .unwrap();
        let selection = reselect_linked_collection(
            collection.id,
            fixture.workspace.clone(),
            selected,
            app.state::<AppState>(),
        );
        tokio::pin!(selection);
        tokio::select! { result = &mut selection => panic!("source reselection bypassed the admitted PGN edit owner: completed {}", result.is_ok()), result = waiting => result.unwrap() }
        // Poll the actual selection admission while the write future still retains its owner.
        // The acquired signal runs before queued native work, so gateway load cannot mask it.
        let mut completed_selection = None;
        let bypassed_owner = std::future::poll_fn(|context| {
            use std::future::Future;
            if let std::task::Poll::Ready(result) = selection.as_mut().poll(context) {
                completed_selection = Some(result);
            }
            std::task::Poll::Ready(acquired.try_recv().is_ok())
        })
        .await;
        release.send(()).unwrap();
        let (write, selection) = if let Some(selection) = completed_selection {
            (write.await, selection)
        } else {
            tokio::join!(write, selection)
        };
        assert!(
            !bypassed_owner,
            "source reselection bypassed the admitted PGN edit owner"
        );
        assert!(
            write.is_ok(),
            "admitted PGN publication lost its binding before reselection"
        );
        selection.unwrap();
        assert!(std::fs::read_to_string(fixture.path("source"))
            .unwrap()
            .contains("Nf3"));
    }

    #[tokio::test]
    async fn native_repair_reselection_keeps_pending_and_coverage_published_while_waiting() {
        use tauri::Manager;
        let fixture = Fixture::new();
        fixture.create(
            "source",
            &game(None, "e4 e5", "old"),
            WorkspaceFileType::Game,
        );
        let collection = fixture.list().pop().unwrap();
        let id = Uuid::parse_str(&collection.id).unwrap();
        let new_source = fixture.create(
            "selected",
            &game(None, "d4 d5", "selected"),
            WorkspaceFileType::Other,
        );
        let incoming = fixture.create(
            "incoming",
            &game(None, "Nf3 Nf6", "pending"),
            WorkspaceFileType::Other,
        );
        let owner = fixture
            .state
            .pgn_repository
            .collection_edit_lock(id)
            .unwrap();
        let guard = owner.lock().await;
        let entered = fixture
            .state
            .pgn_repository
            .observe_edit_lock_wait()
            .unwrap();
        let app = fixture.app();
        let selection = reselect_linked_collection(
            collection.id,
            fixture.workspace.clone(),
            new_source,
            app.state::<AppState>(),
        );
        tokio::pin!(selection);
        tokio::select! {
            result = &mut selection => panic!("reselection bypassed held edit owner: {}", result.is_ok()),
            result = entered => result.unwrap(),
        }
        let pending = fixture
            .service
            .stage_batch(
                &fixture.state.pgn_path_authority,
                id,
                incoming,
                &CancellationToken::new(),
            )
            .unwrap();
        {
            let mut state = fixture.service.lock(&CancellationToken::new()).unwrap();
            let mut registry = CollectionService::state(&mut state).unwrap().clone();
            registry
                .records
                .iter_mut()
                .find(|record| record.id == id)
                .unwrap()
                .coverage_cursor_ms = Some(98765);
            fixture.service.save(&mut state, registry).unwrap();
        }
        drop(guard);
        selection.await.unwrap();
        let record = fixture
            .service
            .record(id, &CancellationToken::new())
            .unwrap();
        assert_eq!(
            record.pending.as_ref().map(|pending| pending.id),
            Some(pending.id),
            "reselection erased the newer pending batch"
        );
        assert_eq!(
            record.coverage_cursor_ms,
            Some(98765),
            "reselection erased newer coverage"
        );
    }

    #[tokio::test]
    async fn native_repair_held_old_source_append_refuses_after_explicit_reselection() {
        use tauri::Manager;
        let fixture = Fixture::new();
        let original = game(None, "e4 e5", "old source");
        fixture.create("source", &original, WorkspaceFileType::Game);
        let collection = fixture.list().pop().unwrap();
        let id = Uuid::parse_str(&collection.id).unwrap();
        let selected_body = game(None, "d4 d5", "selected source");
        let selected = fixture.create("selected", &selected_body, WorkspaceFileType::Other);
        let incoming = fixture.create(
            "incoming",
            &game(None, "Nf3 Nf6", "incoming"),
            WorkspaceFileType::Other,
        );
        let (hook, entered, release) = pgn::BoundedHook::new();
        *fixture.service.append_admission_hook.lock().unwrap() = Some(hook);
        let append = tokio::spawn(Arc::clone(&fixture.service).append_batch(
            fixture.state.pgn_path_authority.clone(),
            id,
            incoming,
            CancellationToken::new(),
        ));
        tokio::time::timeout(Duration::from_secs(10), entered)
            .await
            .unwrap()
            .unwrap();
        let app = fixture.app();
        reselect_linked_collection(
            collection.id,
            fixture.workspace.clone(),
            selected,
            app.state::<AppState>(),
        )
        .await
        .unwrap();
        release.send(()).unwrap();
        let result = append.await.unwrap();
        assert!(
            matches!(result, Err(Error::StaleGame)),
            "held old-source append published after reselection"
        );
        assert_eq!(
            std::fs::read(fixture.path("source")).unwrap(),
            original.as_bytes()
        );
        assert_eq!(
            std::fs::read(fixture.path("selected")).unwrap(),
            selected_body.as_bytes()
        );
        assert!(fixture
            .service
            .record(id, &CancellationToken::new())
            .unwrap()
            .pending
            .is_some());
    }

    #[tokio::test]
    async fn native_repair_save_delete_and_bulk_refuse_superseded_source_binding() {
        use tauri::Manager;
        for action in ["save", "delete", "bulk"] {
            let fixture = Fixture::new();
            let original = game(None, "e4 e5", "old source");
            let old = fixture.create("source", &original, WorkspaceFileType::Game);
            let collection = fixture.list().pop().unwrap();
            let id = Uuid::parse_str(&collection.id).unwrap();
            let selected_body = game(None, "d4 d5", "selected source");
            let selected = fixture.create("selected", &selected_body, WorkspaceFileType::Other);
            let app = fixture.app();
            let owner = fixture
                .state
                .pgn_repository
                .collection_edit_lock(id)
                .unwrap();
            let guard = owner.lock().await;
            let entered = fixture
                .state
                .pgn_repository
                .observe_edit_lock_wait()
                .unwrap();
            let selection = reselect_linked_collection(
                collection.id.clone(),
                fixture.workspace.clone(),
                selected,
                app.state::<AppState>(),
            );
            tokio::pin!(selection);
            tokio::select! { result = &mut selection => panic!("selection bypassed owner: {}", result.is_ok()), result = entered => result.unwrap() }
            let entered = fixture
                .state
                .pgn_repository
                .observe_edit_lock_wait()
                .unwrap();
            let action_future = async {
                match action {
                    "save" => pgn::write_game(
                        old,
                        0,
                        game(None, "Nf3 Nf6", "save"),
                        pgn::WriteExpectation::LinkedGame {
                            stamp: pgn::game_stamp(original.as_bytes()),
                            revision: collection.generation.clone(),
                        },
                        app.state::<AppState>(),
                    )
                    .await
                    .map(|_| ()),
                    "delete" => {
                        pgn::delete_game(
                            old,
                            0,
                            pgn::game_stamp(original.as_bytes()),
                            collection.generation.clone(),
                            app.state::<AppState>(),
                        )
                        .await
                    }
                    _ => edit_linked_collection(
                        collection.id.clone(),
                        collection.generation.clone(),
                        CollectionEdit::RenamePlayer {
                            from: "Player".into(),
                            to: "Changed".into(),
                        },
                        app.state::<AppState>(),
                    )
                    .await
                    .map(|_| ()),
                }
            };
            tokio::pin!(action_future);
            tokio::select! { result = &mut action_future => panic!("{action} bypassed owner: {}", result.is_ok()), result = entered => result.unwrap() }
            drop(guard);
            let (selection, result) = tokio::join!(selection, action_future);
            selection.unwrap();
            assert!(
                matches!(result, Err(Error::StaleGame)),
                "{action} published through a superseded binding"
            );
            assert_eq!(
                std::fs::read(fixture.path("source")).unwrap(),
                original.as_bytes()
            );
            assert_eq!(
                std::fs::read(fixture.path("selected")).unwrap(),
                selected_body.as_bytes()
            );
        }
    }

    #[test]
    fn native_repair_fresh_database_alias_cannot_mutate_a_retired_object() {
        let fixture = Fixture::new();
        let database = fixture.reference("legacy", &game(None, "e4 e5", "original"));
        let target = resolve_database(
            &fixture.state.pgn_path_authority,
            &database,
            PathOperation::DatabaseRead,
        )
        .unwrap();
        let intent = fixture.migration(database, None, MigrationChoice::Database);
        fixture
            .service
            .migrate(
                &fixture.state.pgn_path_authority,
                &fixture.state.workspace_mutation,
                intent,
                &CancellationToken::new(),
            )
            .unwrap();
        // A live original pool also refuses aliases. Release it so this case proves durable
        // collection retirement independently of that transient repository protection.
        fixture
            .state
            .database_repository
            .close_and_invalidate(&target)
            .unwrap();
        std::fs::hard_link(
            fixture.directory.path().join("legacy.db3"),
            fixture.directory.path().join("legacy-alias.db3"),
        )
        .unwrap();
        let alias = DatabaseHandle::new(
            fixture
                .state
                .pgn_path_authority
                .with_mut(|authority| {
                    let grant = authority.grant_dialog_operations(
                        &fixture.directory.path().join("legacy-alias.db3"),
                        "Fresh database picker",
                        PathClass::BoundedDialogGrant,
                        vec![PathOperation::DatabaseMutate],
                        Duration::from_secs(60),
                        4,
                    )?;
                    authority
                        .promote_dialog(
                            &grant,
                            PathClass::PersistentFile,
                            "Fresh database picker",
                            vec![PathOperation::DatabaseMutate],
                        )
                        .map(|commit| commit.id)
                })
                .unwrap()
                .unwrap(),
        );
        let result = write_db_game_blocking(
            &fixture.state.pgn_path_authority,
            &fixture.state.database_repository,
            &fixture.state.search_cache,
            alias,
            1,
            game(None, "d4 d5", "forbidden"),
            &CancellationToken::new(),
        );
        assert!(
            matches!(result, Err(Error::Conflict(_))),
            "fresh capability bypassed retirement of the verified database object: {:?}",
            result.as_ref().err().map(Error::diagnostic)
        );
    }

    #[test]
    fn native_repair_admitted_board_save_refuses_after_migration_retirement() {
        let fixture = Fixture::new();
        let database = fixture.reference("legacy", &game(None, "e4 e5", "original"));
        let intent = fixture.migration(database.clone(), None, MigrationChoice::Database);
        let (entered, release) = install_database_command_checkpoint("mutation_owner", &database);
        let state = fixture.state.clone();
        let handle = database.clone();
        let worker = std::thread::spawn(move || {
            write_db_game_blocking(
                &state.pgn_path_authority,
                &state.database_repository,
                &state.search_cache,
                handle,
                1,
                game(None, "d4 d5", "obsolete save"),
                &CancellationToken::new(),
            )
        });
        entered.recv_timeout(Duration::from_secs(5)).unwrap();
        fixture
            .service
            .migrate(
                &fixture.state.pgn_path_authority,
                &fixture.state.workspace_mutation,
                intent,
                &CancellationToken::new(),
            )
            .unwrap();
        release.send(()).unwrap();
        assert!(
            matches!(worker.join().unwrap(), Err(Error::Conflict(_))),
            "an admitted board save committed after retirement"
        );
    }

    #[test]
    fn native_repair_writer_that_wins_is_preserved_in_snapshot_and_source() {
        let fixture = Fixture::new();
        let database = fixture.reference("legacy", &game(None, "e4 e5", "original"));
        let intent = fixture.migration(database.clone(), None, MigrationChoice::Database);
        let archive_leaf = format!("{}-original.db3", intent.id);
        let (entered, release) = install_database_command_checkpoint("mutation_owned", &database);
        let state = fixture.state.clone();
        let worker = std::thread::spawn(move || {
            write_db_game_blocking(
                &state.pgn_path_authority,
                &state.database_repository,
                &state.search_cache,
                database,
                1,
                game(None, "d4 d5", "winning save"),
                &CancellationToken::new(),
            )
        });
        entered.recv_timeout(Duration::from_secs(5)).unwrap();
        let (snapshot_entered, snapshot_release) =
            install_database_command_checkpoint("migration_snapshot", &intent.database);
        let service = Arc::clone(&fixture.service);
        let state = fixture.state.clone();
        let (started, admission) = std::sync::mpsc::sync_channel(1);
        let migration = std::thread::spawn(move || {
            started.send(()).unwrap();
            service.migrate(
                &state.pgn_path_authority,
                &state.workspace_mutation,
                intent,
                &CancellationToken::new(),
            )
        });
        admission.recv_timeout(Duration::from_secs(5)).unwrap();
        let snapshot_bypassed_owner = snapshot_entered
            .recv_timeout(Duration::from_millis(250))
            .is_ok();
        release.send(()).unwrap();
        if !snapshot_bypassed_owner {
            snapshot_entered
                .recv_timeout(Duration::from_secs(5))
                .unwrap();
        }
        snapshot_release.send(()).unwrap();
        let result = migration.join().unwrap();
        worker.join().unwrap().unwrap();
        assert!(
            !snapshot_bypassed_owner,
            "migration snapshot bypassed the admitted writer mutation owner"
        );
        let collection = result.unwrap();
        let source = std::fs::read_to_string(fixture.path("migrated")).unwrap();
        assert!(
            source.contains("d4"),
            "winning writer was absent from the migration source"
        );
        let archive = fixture
            .service
            .root
            .database_target(OsStr::new(&archive_leaf))
            .unwrap();
        let mut db = fixture
            .state
            .database_repository
            .connection(&archive, None)
            .unwrap();
        let moves: Vec<u8> = games::table.select(games::moves).first(&mut *db).unwrap();
        assert_eq!(
            moves,
            parse_identity_fixture_moves(&game(None, "d4 d5", "winning save")),
            "winning writer was absent from the archive"
        );
        assert_eq!(fixture.rows(&collection).len(), 1);
    }

    fn parse_identity_fixture_moves(body: &str) -> Vec<u8> {
        BufferedReader::new(body.as_bytes())
            .read_game(&mut Importer::new(None))
            .unwrap()
            .unwrap()
            .unwrap()
            .moves
    }

    #[tokio::test]
    async fn native_repair_invalid_legacy_evidence_blocks_only_related_incoming_games() {
        for ambiguous in [false, true] {
            let mut fixture = Fixture::new();
            let original = game(None, "e4 e5", "legacy");
            fixture.create("source", &original, WorkspaceFileType::Game);
            let collection = fixture.list().pop().unwrap();
            let id = Uuid::parse_str(&collection.id).unwrap();
            fixture.account(&collection.id, "chesscom");
            let first = fixture.create(
                "first",
                &game(Some("123"), "e4 e5", "provider"),
                WorkspaceFileType::Other,
            );
            assert_eq!(
                Arc::clone(&fixture.service)
                    .append_batch(
                        fixture.state.pgn_path_authority.clone(),
                        id,
                        first,
                        CancellationToken::new()
                    )
                    .await
                    .unwrap()
                    .appended,
                0
            );
            fixture.restart();
            let changed = if ambiguous {
                format!("{original}{original}")
            } else {
                game(Some("777"), "Nf3 Nf6", "replacement")
            };
            std::fs::write(fixture.path("source"), &changed).unwrap();
            fixture.list();
            let unrelated = fixture.create(
                "unrelated",
                &game(Some("999"), "d4 d5", "unrelated"),
                WorkspaceFileType::Other,
            );
            assert_eq!(
                Arc::clone(&fixture.service)
                    .append_batch(
                        fixture.state.pgn_path_authority.clone(),
                        id,
                        unrelated,
                        CancellationToken::new()
                    )
                    .await
                    .unwrap()
                    .appended,
                1,
                "unrelated incoming game was globally blocked by missing evidence"
            );
            let before = std::fs::read(fixture.path("source")).unwrap();
            let related = fixture.create(
                "related",
                &game(Some("456"), "e4 e5", "related"),
                WorkspaceFileType::Other,
            );
            let result = Arc::clone(&fixture.service)
                .append_batch(
                    fixture.state.pgn_path_authority.clone(),
                    id,
                    related,
                    CancellationToken::new(),
                )
                .await;
            assert!(
                matches!(result, Err(Error::Conflict(_))),
                "invalid evidence silently reassigned a legacy occurrence"
            );
            assert_eq!(std::fs::read(fixture.path("source")).unwrap(), before);
            assert!(fixture
                .service
                .record(id, &CancellationToken::new())
                .unwrap()
                .pending
                .is_some());
        }
    }

    #[test]
    fn native_repair_scanner_inline_tags_keep_source_ordinals() {
        let fixture = Fixture::new();
        let body = "\u{feff}[Event \"A\"] [Site \"X\"]\r\n[White \"W\"]\r\n[Black \"B\"]\r\n[Result \"*\"]\r\n\r\n1. e4 *\r\n\r\n[Event \"B\"]\r\n[White \"Next\"]\r\n\r\n1. d4 *\r\n";
        fixture.create("inline", body, WorkspaceFileType::Game);
        let collection = fixture.list().pop().unwrap();
        let mut rows = fixture.rows(&collection);
        rows.sort_by_key(|row| row.linked.as_ref().unwrap().ordinal);
        assert_eq!(
            rows.len(),
            2,
            "inline header pairs split a game into indexed fragments"
        );
        assert_eq!(
            rows[0].linked.as_ref().unwrap().ordinal,
            0,
            "inline header pairs split a game into indexed fragments"
        );
        assert_eq!(
            rows[1].linked.as_ref().unwrap().ordinal,
            1,
            "inline header pairs split a game into indexed fragments"
        );
        assert_eq!(
            rows.iter()
                .map(|row| (row.event.as_str(), row.white.as_str()))
                .collect::<Vec<_>>(),
            vec![("A", "W"), ("B", "Next")],
            "inline header pairs split a game into indexed fragments or replaced game identities"
        );
        assert_eq!(
            std::fs::read(fixture.path("inline")).unwrap(),
            body.as_bytes()
        );
    }

    #[tokio::test]
    async fn native_repair_stale_batch_completion_cannot_erase_a_new_batch() {
        let fixture = Fixture::new();
        fixture.create(
            "source",
            &game(None, "e4 e5", "source"),
            WorkspaceFileType::Game,
        );
        let collection = fixture.list().pop().unwrap();
        let id = Uuid::parse_str(&collection.id).unwrap();
        let first = fixture.create(
            "first",
            &game(None, "d4 d5", "first"),
            WorkspaceFileType::Other,
        );
        let old = fixture
            .service
            .stage_batch(
                &fixture.state.pgn_path_authority,
                id,
                first.clone(),
                &CancellationToken::new(),
            )
            .unwrap();
        Arc::clone(&fixture.service)
            .append_batch(
                fixture.state.pgn_path_authority.clone(),
                id,
                first,
                CancellationToken::new(),
            )
            .await
            .unwrap();
        let second = fixture.create(
            "second",
            &game(None, "Nf3 Nf6", "second"),
            WorkspaceFileType::Other,
        );
        let current = fixture
            .service
            .stage_batch(
                &fixture.state.pgn_path_authority,
                id,
                second,
                &CancellationToken::new(),
            )
            .unwrap();
        let result = fixture.service.finish_pending(
            &fixture.state.pgn_path_authority,
            id,
            old,
            &CancellationToken::new(),
        );
        assert!(
            matches!(result, Err(Error::StaleGame)),
            "stale completion replaced the current pending batch"
        );
        assert_eq!(
            fixture
                .service
                .record(id, &CancellationToken::new())
                .unwrap()
                .pending
                .map(|pending| pending.id),
            Some(current.id)
        );
    }

    #[tokio::test]
    async fn native_repair_preparation_uncertainty_is_not_source_publication() {
        let fixture = Fixture::new();
        let original = game(None, "e4 e5", "original");
        fixture.create("source", &original, WorkspaceFileType::Game);
        let collection = fixture.list().pop().unwrap();
        let id = Uuid::parse_str(&collection.id).unwrap();
        let incoming = fixture.create(
            "incoming",
            &game(None, "d4 d5", "incoming"),
            WorkspaceFileType::Other,
        );
        *fixture.service.batch_preparation_injector.lock().unwrap() = Some(Arc::new(
            fs::ParentSyncFault("registry preparation parent sync"),
        ));
        let outcome = Arc::clone(&fixture.service)
            .append_batch(
                fixture.state.pgn_path_authority.clone(),
                id,
                incoming.clone(),
                CancellationToken::new(),
            )
            .await;
        assert!(
            matches!(
                outcome,
                Err(Error::CommittedDurabilityUncertain(
                    crate::error::DurabilityStage::RegistryReplacement
                ))
            ),
            "private preparation uncertainty claimed a committed source"
        );
        assert_eq!(
            std::fs::read(fixture.path("source")).unwrap(),
            original.as_bytes()
        );
        assert!(fixture
            .service
            .record(id, &CancellationToken::new())
            .unwrap()
            .pending
            .is_some());
        *fixture.service.batch_preparation_injector.lock().unwrap() = None;
        let outcome = Arc::clone(&fixture.service)
            .append_batch(
                fixture.state.pgn_path_authority.clone(),
                id,
                incoming,
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(outcome.appended, 1);
    }

    #[tokio::test]
    async fn native_repair_retry_reports_source_confirmation_independently_of_index_failure() {
        let fixture = Fixture::new();
        fixture.create(
            "source",
            &game(None, "e4 e5", "original"),
            WorkspaceFileType::Game,
        );
        let collection = fixture.list().pop().unwrap();
        let id = Uuid::parse_str(&collection.id).unwrap();
        let incoming = fixture.create(
            "incoming",
            &game(None, "d4 d5", "incoming"),
            WorkspaceFileType::Other,
        );
        fixture
            .state
            .pgn_repository
            .set_atomic_file_injector(Some(Arc::new(fs::ParentSyncFault(
                "source publication parent sync",
            ))))
            .unwrap();
        let first = Arc::clone(&fixture.service)
            .append_batch(
                fixture.state.pgn_path_authority.clone(),
                id,
                incoming.clone(),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert!(first.committed && !first.durability_confirmed);
        let bytes = std::fs::read(fixture.path("source")).unwrap();
        fixture
            .state
            .pgn_repository
            .set_atomic_file_injector(None)
            .unwrap();
        let record = fixture
            .service
            .record(id, &CancellationToken::new())
            .unwrap();
        let cache = fixture.service.target(&record).unwrap();
        fixture
            .state
            .database_repository
            .close_and_invalidate(&cache)
            .unwrap();
        std::fs::remove_file(cache.path()).unwrap();
        *fixture.service.rebuild_hook.lock().unwrap() = Some(Box::new(|| {
            Err(Error::ResourceLimit("index refresh unavailable".into()))
        }));
        let retry = Arc::clone(&fixture.service)
            .append_batch(
                fixture.state.pgn_path_authority.clone(),
                id,
                incoming,
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert!(
            retry.committed && retry.durability_confirmed && !retry.index_ready,
            "successful source confirmation was hidden by index failure"
        );
        assert!(fixture
            .service
            .record(id, &CancellationToken::new())
            .unwrap()
            .pending
            .is_some());
        assert_eq!(std::fs::read(fixture.path("source")).unwrap(), bytes);
    }

    #[tokio::test]
    async fn native_repair_retry_must_sync_authoritative_source_parent() {
        struct ConfirmationParentFault(std::sync::atomic::AtomicBool);
        impl fs::AtomicWriterInjector for ConfirmationParentFault {
            fn inject(&self, point: fs::AtomicFileFaultPoint) -> std::io::Result<()> {
                use std::sync::atomic::Ordering;
                match point {
                    fs::AtomicFileFaultPoint::TempfileCreate => {
                        self.0.store(true, Ordering::SeqCst);
                    }
                    fs::AtomicFileFaultPoint::ParentSync
                        if !self.0.swap(false, Ordering::SeqCst) =>
                    {
                        return Err(std::io::Error::other(
                            "current source parent confirmation refused",
                        ));
                    }
                    _ => {}
                }
                Ok(())
            }
        }
        let fixture = Fixture::new();
        fixture.create(
            "source",
            &game(None, "e4 e5", "original"),
            WorkspaceFileType::Game,
        );
        let collection = fixture.list().pop().unwrap();
        let id = Uuid::parse_str(&collection.id).unwrap();
        let incoming = fixture.create(
            "incoming",
            &game(None, "d4 d5", "incoming"),
            WorkspaceFileType::Other,
        );
        fixture
            .state
            .pgn_repository
            .set_atomic_file_injector(Some(Arc::new(fs::ParentSyncFault("source parent sync"))))
            .unwrap();
        let outcome = Arc::clone(&fixture.service)
            .append_batch(
                fixture.state.pgn_path_authority.clone(),
                id,
                incoming.clone(),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert!(outcome.committed && !outcome.durability_confirmed);
        let bytes = std::fs::read(fixture.path("source")).unwrap();
        fixture
            .state
            .pgn_repository
            .set_atomic_file_injector(Some(Arc::new(ConfirmationParentFault(
                std::sync::atomic::AtomicBool::new(false),
            ))))
            .unwrap();
        let outcome = Arc::clone(&fixture.service)
            .append_batch(
                fixture.state.pgn_path_authority.clone(),
                id,
                incoming.clone(),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert!(
            outcome.committed && !outcome.durability_confirmed,
            "retry confirmed durability without syncing source parent"
        );
        assert!(
            fixture
                .service
                .record(id, &CancellationToken::new())
                .unwrap()
                .pending
                .is_some(),
            "failed source confirmation discarded the pending batch"
        );
        assert_eq!(std::fs::read(fixture.path("source")).unwrap(), bytes);
        fixture
            .state
            .pgn_repository
            .set_atomic_file_injector(None)
            .unwrap();
        let outcome = Arc::clone(&fixture.service)
            .append_batch(
                fixture.state.pgn_path_authority.clone(),
                id,
                incoming,
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert!(outcome.committed && outcome.durability_confirmed && outcome.index_ready);
        assert_eq!(std::fs::read(fixture.path("source")).unwrap(), bytes);
    }

    #[test]
    fn native_repair_rename_changes_only_player_value_spans() {
        let input = b"\xef\xbb\xbf  [Event \"A\"] [White \"Pl\\\"ayer\"] [Site \"keep\"]\r\n\t[Black \"Pl\\\"ayer\"] [Custom \"escape \\\\ keep\"]\r\n\r\n1. e4 {Pl\"ayer} *\r\n";
        let expected = b"\xef\xbb\xbf  [Event \"A\"] [White \"New\\\\name\"] [Site \"keep\"]\r\n\t[Black \"New\\\\name\"] [Custom \"escape \\\\ keep\"]\r\n\r\n1. e4 {Pl\"ayer} *\r\n";
        assert_eq!(
            rename_player_tags(input, "Pl\"ayer", "New\\name").unwrap(),
            expected,
            "player rename changed unrelated inline tag bytes"
        );
    }

    #[test]
    fn native_r2_rename_preserves_percent_escape_header_context() {
        let input = b"\xef\xbb\xbf[Event \"A\"]\r\n% exporter { [White \"Pl\\\"ayer\"]\r\n[White \"Pl\\\"ayer\"] [Custom \"keep\"]\r\n% } ignored\r\n[Black \"Pl\\\"ayer\"]\r\n\r\n1. e4 {\r\n[White \"Pl\\\"ayer\"]\r\n}\r\n% escape after moves\r\n[Black \"Pl\\\"ayer\"]\r\n*\r\n";
        let expected = b"\xef\xbb\xbf[Event \"A\"]\r\n% exporter { [White \"Pl\\\"ayer\"]\r\n[White \"New\\\\name\"] [Custom \"keep\"]\r\n% } ignored\r\n[Black \"New\\\\name\"]\r\n\r\n1. e4 {\r\n[White \"Pl\\\"ayer\"]\r\n}\r\n% escape after moves\r\n[Black \"Pl\\\"ayer\"]\r\n*\r\n";
        assert_eq!(
            rename_player_tags(input, "Pl\"ayer", "New\\name").unwrap(),
            expected,
            "percent escape line ended the initial header section"
        );
        for input in [
            b"[Event \"A\"]\n{ comment\n% escape\n[White \"Player\"]\n}\n*\n".as_slice(),
            b"[Event \"A\"]\n1. e4\n% escape\n[White \"Player\"]\n*\n",
            b"[Event \"A\"]\n % not column zero\n[White \"Player\"]\n*\n",
        ] {
            assert_eq!(
                rename_player_tags(input, "Player", "Changed").unwrap(),
                input
            );
        }
    }

    #[tokio::test]
    async fn linked_bulk_edits_preserve_custom_data_and_stale_duplicate_occurrences() {
        use tauri::Manager;
        let fixture = Fixture::new();
        let original = game(Some("123"), "e4 e5", "preserve $1 (1. d4 d5)")
            .replace("[Custom", "[SetUp \"1\"]\n[FEN \"rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq d3 0 7\"]\n[Custom")
            .replace("1. e4 e5", "7... d5 8. c4");
        fixture.create(
            "games",
            &format!("{original}{original}"),
            WorkspaceFileType::Game,
        );
        let collection = fixture.list().pop().unwrap();
        let rows = fixture.rows(&collection);
        assert_ne!(
            rows[0].linked.as_ref().unwrap().ordinal,
            rows[1].linked.as_ref().unwrap().ordinal,
            "identical source occurrences collapsed"
        );
        let app = fixture.app();
        edit_linked_collection(
            collection.id.clone(),
            collection.generation.clone(),
            CollectionEdit::RenamePlayer {
                from: "Player".into(),
                to: "Edited Player".into(),
            },
            app.state::<AppState>(),
        )
        .await
        .unwrap();
        let renamed = std::fs::read_to_string(fixture.path("games")).unwrap();
        assert_eq!(
            renamed,
            format!("{original}{original}")
                .replace("[White \"Player\"]", "[White \"Edited Player\"]")
        );
        assert!(
            matches!(
                edit_linked_collection(
                    collection.id.clone(),
                    collection.generation,
                    CollectionEdit::Delete {
                        games: vec![rows[0].linked.clone().unwrap()]
                    },
                    app.state::<AppState>()
                )
                .await,
                Err(Error::StaleGame)
            ),
            "old equal-text locator deleted a shifted occurrence"
        );
        let current = fixture.list().pop().unwrap();
        edit_linked_collection(
            current.id,
            current.generation,
            CollectionEdit::Cleanup {
                empty: false,
                duplicates: true,
            },
            app.state::<AppState>(),
        )
        .await
        .unwrap();
        assert_eq!(fixture.rows(&fixture.list().pop().unwrap()).len(), 1);
        assert_eq!(
            std::fs::read_to_string(fixture.path("games")).unwrap(),
            original.replace("[White \"Player\"]", "[White \"Edited Player\"]")
        );
    }

    #[test]
    fn migration_publication_faults_restart_without_losing_either_original() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        struct FailBoundary {
            count: AtomicUsize,
            nth: usize,
            point: fs::AtomicFileFaultPoint,
        }
        impl fs::AtomicWriterInjector for FailBoundary {
            fn inject(&self, point: fs::AtomicFileFaultPoint) -> std::io::Result<()> {
                if point == self.point && self.count.fetch_add(1, Ordering::SeqCst) + 1 == self.nth
                {
                    Err(std::io::Error::other(
                        "migration publication fixture refusal",
                    ))
                } else {
                    Ok(())
                }
            }
        }
        for point in [
            fs::AtomicFileFaultPoint::Write,
            fs::AtomicFileFaultPoint::Rename,
            fs::AtomicFileFaultPoint::ParentSync,
        ] {
            let baseline = Fixture::new();
            let database =
                baseline.reference("original", &game(Some("456"), "d4 d5", "database version"));
            let source = baseline.create(
                "selected",
                &game(Some("123"), "e4 e5", "original PGN edit"),
                WorkspaceFileType::Other,
            );
            let intent = baseline.migration(database, Some(source), MigrationChoice::Database);
            let observer = Arc::new(FailBoundary {
                count: AtomicUsize::new(0),
                nth: usize::MAX,
                point,
            });
            let guard = fs::install_test_atomic_file_injector(observer.clone());
            baseline
                .service
                .migrate(
                    &baseline.state.pgn_path_authority,
                    &baseline.state.workspace_mutation,
                    intent,
                    &CancellationToken::new(),
                )
                .unwrap();
            drop(guard);
            let boundaries = observer.count.load(Ordering::SeqCst);
            assert!(boundaries > 0);
            for nth in 1..=boundaries {
                let mut fixture = Fixture::new();
                let original = game(Some("123"), "e4 e5", "original PGN edit");
                let database = fixture.reference(
                    "original",
                    &game(Some("456"), "d4 d5", "different database version"),
                );
                let source = fixture.create("selected", &original, WorkspaceFileType::Other);
                let intent = fixture.migration(database, Some(source), MigrationChoice::Database);
                let injector = Arc::new(FailBoundary {
                    count: AtomicUsize::new(0),
                    nth,
                    point,
                });
                let fault = fs::install_test_atomic_file_injector(injector);
                let _result = fixture.service.migrate(
                    &fixture.state.pgn_path_authority,
                    &fixture.state.workspace_mutation,
                    intent.clone(),
                    &CancellationToken::new(),
                );
                drop(fault);
                assert_eq!(
                    std::fs::read(fixture.path("selected")).unwrap(),
                    original.as_bytes(),
                    "migration boundary {point:?}/{nth} overwrote the selected original"
                );
                fixture.restart();
                let saved = CollectionService::state(
                    &mut fixture.service.lock(&CancellationToken::new()).unwrap(),
                )
                .unwrap()
                .migrations
                .iter()
                .find(|saved| saved.id == intent.id)
                .unwrap()
                .clone();
                let collection = fixture
                    .service
                    .migrate(
                        &fixture.state.pgn_path_authority,
                        &fixture.state.workspace_mutation,
                        saved,
                        &CancellationToken::new(),
                    )
                    .unwrap_or_else(|error| panic!("restart after {point:?}/{nth}: {error}"));
                let repeated = CollectionService::state(
                    &mut fixture.service.lock(&CancellationToken::new()).unwrap(),
                )
                .unwrap()
                .migrations
                .iter()
                .find(|saved| saved.id == intent.id)
                .unwrap()
                .clone();
                assert_eq!(
                    fixture
                        .service
                        .migrate(
                            &fixture.state.pgn_path_authority,
                            &fixture.state.workspace_mutation,
                            repeated,
                            &CancellationToken::new()
                        )
                        .unwrap()
                        .id,
                    collection.id
                );
                assert_eq!(fixture.rows(&collection).len(), 1);
                assert_eq!(
                    std::fs::read(fixture.path("selected")).unwrap(),
                    original.as_bytes()
                );
                let archive = fixture
                    .service
                    .root
                    .database_target(OsStr::new(&format!("{}-original.db3", intent.id)))
                    .unwrap();
                let mut db = fixture
                    .service
                    .repository
                    .connection(&archive, None)
                    .unwrap();
                assert_eq!(
                    games::table.count().get_result::<i64>(&mut *db).unwrap(),
                    1,
                    "WAL-consistent archive lost history"
                );
                let source_archive = fixture
                    .service
                    .root
                    .path()
                    .join(format!("{}-original.pgn", intent.id));
                assert_eq!(std::fs::read(source_archive).unwrap(), original.as_bytes());
            }
            println!("linked_collections migration {point:?}: all {boundaries} durable boundaries recovered after restart");
        }
    }

    #[test]
    fn startup_maintenance_removes_only_unreferenced_owned_artifacts() {
        let mut fixture = Fixture::new();
        fixture.create(
            "games",
            &game(None, "e4 e5", "kept"),
            WorkspaceFileType::Game,
        );
        let current = fixture.list().pop().unwrap();
        let orphan = fixture
            .service
            .root
            .path()
            .join(format!("{}.db3", Uuid::new_v4()));
        std::fs::write(&orphan, b"abandoned cache").unwrap();
        let unknown = fixture.service.root.path().join("leave-this-file");
        std::fs::write(&unknown, b"preserved").unwrap();
        fixture.restart();
        assert_eq!(fixture.list()[0].id, current.id);
        assert!(!orphan.exists());
        assert_eq!(std::fs::read(unknown).unwrap(), b"preserved");
    }

    #[test]
    fn explicit_purpose_rename_replacement_restart_and_missing_identity() {
        let mut fixture = Fixture::new();
        let original = game(Some("123"), "e4 e5", "custom (1. d4 d5) $1");
        let file = fixture.create("games", &original, WorkspaceFileType::Game);
        for (name, purpose) in [
            ("repertoire", WorkspaceFileType::Repertoire),
            ("other", WorkspaceFileType::Other),
            ("puzzle", WorkspaceFileType::Puzzle),
        ] {
            fixture.create(name, &original, purpose);
        }
        let collection = fixture.list().pop().unwrap();
        assert_eq!(fixture.list().len(), 1, "plain files were indexed");
        assert!(matches!(collection.status, CollectionStatus::Ready));
        let rows = fixture.rows(&collection);
        assert_eq!(rows.len(), 1);
        let opened = fixture
            .service
            .resolve_game(
                &fixture.state.pgn_path_authority,
                collection.database.as_ref().unwrap(),
                rows[0].id,
                rows[0].linked.as_ref(),
                &CancellationToken::new(),
            )
            .unwrap()
            .unwrap();
        assert_eq!(
            opened.game.pgn.as_bytes(),
            original.as_bytes(),
            "linked opening reconstructed a lossy database row"
        );
        crate::file_workspace::rename_workspace_file_blocking(
            fixture.workspace.clone(),
            file,
            "renamed".into(),
            WorkspaceMetadata {
                file_type: WorkspaceFileType::Game,
                tags: vec!["preserved".into()],
            },
            &fixture.state.pgn_path_authority,
            &fixture.state.workspace_mutation,
            &CancellationToken::new(),
        )
        .unwrap();
        let renamed = fixture.list().pop().unwrap();
        assert_eq!(renamed.id, collection.id, "app rename lost the UUID");
        fixture.restart();
        assert_eq!(
            fixture.list()[0].id,
            collection.id,
            "restart lost collection identity"
        );
        let replacement = game(Some("456"), "d4 d5", "new data (1. e4 e5) $1");
        let replaced = fixture.directory.path().join("replacement.pgn");
        std::fs::write(&replaced, &replacement).unwrap();
        std::fs::rename(replaced, fixture.path("renamed")).unwrap();
        let current = fixture.list().pop().unwrap();
        assert_eq!(current.id, collection.id);
        assert_ne!(current.generation, renamed.generation);
        assert_eq!(fixture.rows(&current).len(), 1);
        assert!(matches!(
            fixture.service.resolve_game(
                &fixture.state.pgn_path_authority,
                current.database.as_ref().unwrap(),
                rows[0].id,
                rows[0].linked.as_ref(),
                &CancellationToken::new()
            ),
            Err(Error::StaleGame)
        ));
        std::fs::rename(fixture.path("renamed"), fixture.path("externally-moved")).unwrap();
        assert!(
            fixture
                .service
                .refresh(
                    &fixture.state.pgn_path_authority,
                    Uuid::parse_str(&current.id).unwrap(),
                    &CancellationToken::new()
                )
                .is_err(),
            "external rename silently rebound by content or basename"
        );
    }

    #[test]
    fn same_size_mtime_preserved_rewrite_changes_generation_and_rejects_normalization_race() {
        let fixture = Fixture::new();
        let first = game(Some("123"), "e4 e5", "first");
        let second = game(Some("456"), "d4 d5", "other");
        assert_eq!(first.len(), second.len());
        fixture.create("games", &first, WorkspaceFileType::Game);
        let collection = fixture.list().pop().unwrap();
        let app = fixture.app();
        let query: GameQuery = serde_json::from_value(serde_json::json!({"position":{"fen":"rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1","type_":"exact"}})).unwrap();
        let before = super::super::search::run_position_search(
            app.handle(),
            collection.database.as_ref().unwrap(),
            query.clone(),
            "linked-before",
        )
        .unwrap();
        assert_eq!(before.0[0].move_, "e5");
        assert_eq!(before.1.len(), 1);
        let modified = std::fs::metadata(fixture.path("games"))
            .unwrap()
            .modified()
            .unwrap();
        std::fs::write(fixture.path("games"), &second).unwrap();
        File::options()
            .write(true)
            .open(fixture.path("games"))
            .unwrap()
            .set_modified(modified)
            .unwrap();
        let current = fixture.list().pop().unwrap();
        assert_ne!(
            collection.generation, current.generation,
            "ctime was omitted from generation"
        );
        let after = super::super::search::run_position_search(
            app.handle(),
            current.database.as_ref().unwrap(),
            query,
            "linked-after",
        )
        .unwrap();
        assert!(
            after.0.is_empty() && after.1.is_empty(),
            "old mmap statistics survived the source rewrite"
        );
        let target = fixture
            .service
            .target(
                &fixture
                    .service
                    .record(
                        Uuid::parse_str(&current.id).unwrap(),
                        &CancellationToken::new(),
                    )
                    .unwrap(),
            )
            .unwrap();
        let mut db = fixture
            .service
            .repository
            .connection(&target, None)
            .unwrap();
        let result = read_snapshot(
            &mut db,
            &fixture.state.pgn_path_authority,
            current.database.as_ref().unwrap(),
            |_| {
                std::fs::write(fixture.path("games"), &first)?;
                Ok(())
            },
        );
        assert!(
            matches!(result, Err(Error::StaleGame)),
            "a query returned rows from an obsolete admitted source generation"
        );
    }

    #[test]
    fn source_rewrite_after_mmap_admission_refuses_cached_and_normalized_search_results() {
        let fixture = Fixture::new();
        let original = game(Some("123"), "e4 e5", "original");
        fixture.create("source", &original, WorkspaceFileType::Game);
        let collection = fixture.list().pop().unwrap();
        let app = fixture.app();
        let query: GameQuery = serde_json::from_value(serde_json::json!({"position":{"fen":"rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1","type_":"exact"}})).unwrap();
        super::super::search::run_position_search(
            app.handle(),
            collection.database.as_ref().unwrap(),
            query.clone(),
            "warm-racing-source",
        )
        .unwrap();
        for cached in [false, true] {
            std::fs::write(fixture.path("source"), &original).unwrap();
            fixture.list();
            super::super::search::run_position_search(
                app.handle(),
                collection.database.as_ref().unwrap(),
                query.clone(),
                "warm-current-source",
            )
            .unwrap();
            let path = fixture.path("source");
            super::super::search::AFTER_FAST_IDENTITY_PROBE_HOOK.with(|slot| {
                *slot.borrow_mut() = Some(Box::new(move || {
                    std::fs::write(
                        path,
                        game(
                            Some("456"),
                            "d4 d5",
                            "external rewrite after mmap admission",
                        ),
                    )
                    .unwrap()
                }))
            });
            let mut admitted = query.clone();
            if !cached {
                admitted.start_date = Some("2026.01.01".into());
            }
            let result = super::super::search::run_position_search(
                app.handle(),
                collection.database.as_ref().unwrap(),
                admitted,
                "racing-source",
            );
            assert!(
            matches!(result, Err(Error::StaleGame)),
            "source changed after admission but cached={cached} returned mixed-generation results"
        );
        }
    }

    #[tokio::test]
    async fn an_old_equal_text_locator_cannot_save_a_different_duplicate_after_an_external_insertion(
    ) {
        use tauri::Manager;
        let fixture = Fixture::new();
        let duplicate = game(None, "e4 e5", "identical source occurrence");
        let file = fixture.create(
            "source",
            &format!("{duplicate}{duplicate}"),
            WorkspaceFileType::Game,
        );
        let collection = fixture.list().pop().unwrap();
        let selected = fixture
            .rows(&collection)
            .into_iter()
            .find_map(|game| game.linked.filter(|locator| locator.ordinal == 1))
            .unwrap();
        let external = format!(
            "{}{duplicate}{duplicate}",
            game(None, "d4 d5", "external insertion")
        );
        std::fs::write(fixture.path("source"), &external).unwrap();
        let app = fixture.app();
        let result = pgn::write_game(
            file,
            selected.ordinal,
            game(None, "c4 c5", "dirty tree"),
            pgn::WriteExpectation::LinkedGame {
                stamp: selected.stamp,
                revision: selected.generation,
            },
            app.state::<AppState>(),
        )
        .await;
        assert!(
            matches!(result, Err(Error::StaleGame)),
            "an old equal-text locator saved a different source occurrence"
        );
        assert_eq!(
            std::fs::read(fixture.path("source")).unwrap(),
            external.as_bytes()
        );
    }

    #[test]
    fn rebuild_revalidation_rollback_cancellation_and_recovery() {
        let fixture = Fixture::new();
        fixture.create(
            "games",
            &game(Some("123"), "e4 e5", "first"),
            WorkspaceFileType::Game,
        );
        let collection = fixture.list().pop().unwrap();
        let id = Uuid::parse_str(&collection.id).unwrap();
        let target = fixture
            .service
            .target(
                &fixture
                    .service
                    .record(id, &CancellationToken::new())
                    .unwrap(),
            )
            .unwrap();
        let before = fixture
            .service
            .repository
            .database_identity(&target)
            .unwrap()
            .data_revision;
        let before_moves = games::table
            .select(games::moves)
            .load::<Vec<u8>>(
                &mut *fixture
                    .service
                    .repository
                    .connection(&target, None)
                    .unwrap(),
            )
            .unwrap();
        std::fs::write(fixture.path("games"), game(Some("456"), "d4 d5", "second")).unwrap();
        *fixture.service.rebuild_hook.lock().unwrap() = Some(Box::new(|| {
            Err(Error::ResourceLimit(
                "simulated index storage refusal".into(),
            ))
        }));
        assert!(fixture
            .service
            .refresh(
                &fixture.state.pgn_path_authority,
                id,
                &CancellationToken::new()
            )
            .is_err());
        let mut db = fixture
            .service
            .repository
            .connection(&target, None)
            .unwrap();
        assert_eq!(
            repository::read_data_revision(&mut db).unwrap(),
            before,
            "failed rebuild published a partial generation"
        );
        assert_eq!(
            games::table
                .select(games::moves)
                .load::<Vec<u8>>(&mut *db)
                .unwrap(),
            before_moves,
            "failed rebuild exposed partially replaced game rows"
        );
        assert_eq!(
            linked_metadata(&mut db).unwrap().unwrap().0,
            collection.generation,
            "failed rebuild committed source metadata"
        );
        drop(db);
        let token = CancellationToken::new();
        let cancel = token.clone();
        *fixture.service.rebuild_hook.lock().unwrap() = Some(Box::new(move || {
            cancel.cancel();
            Ok(())
        }));
        assert!(matches!(
            fixture
                .service
                .refresh(&fixture.state.pgn_path_authority, id, &token),
            Err(Error::Cancellation)
        ));
        let path = fixture.path("games");
        *fixture.service.rebuild_hook.lock().unwrap() = Some(Box::new(move || {
            std::fs::write(&path, game(Some("789"), "c4 c5", "racing"))?;
            Ok(())
        }));
        assert!(
            matches!(
                fixture.service.refresh(
                    &fixture.state.pgn_path_authority,
                    id,
                    &CancellationToken::new()
                ),
                Err(Error::StaleGame)
            ),
            "racing source was published as current"
        );
        *fixture.service.rebuild_hook.lock().unwrap() = None;
        assert!(fixture
            .service
            .refresh(
                &fixture.state.pgn_path_authority,
                id,
                &CancellationToken::new()
            )
            .is_ok());
        assert_eq!(fixture.rows(&fixture.list().pop().unwrap()).len(), 1);
    }

    #[test]
    fn malformed_games_keep_ordinal_gaps_and_identical_occurrences_remain_distinct() {
        let fixture = Fixture::new();
        let valid = game(None, "e4 e5", "kept");
        let body = format!(
            "{valid}[Event \"Malformed\"]\n[FEN \"not a position\"]\n\n*\n\n{valid}{valid}"
        );
        fixture.create("source", &body, WorkspaceFileType::Tournament);
        let collection = fixture.list().pop().unwrap();
        assert!(matches!(collection.status, CollectionStatus::Ready));
        assert_eq!(collection.omitted, 1);
        let rows = fixture.rows(&collection);
        assert_eq!(rows.len(), 3);
        let mut ordinals = rows
            .iter()
            .map(|game| game.linked.as_ref().unwrap().ordinal)
            .collect::<Vec<_>>();
        ordinals.sort_unstable();
        assert_eq!(ordinals, vec![0, 2, 3]);
        let metadata = get_db_info_blocking(
            &fixture.state.pgn_path_authority,
            &fixture.state.database_repository,
            collection.database.unwrap(),
        )
        .unwrap();
        assert_eq!(metadata.info.game_count, 3);
        assert_eq!(
            metadata.info.player_count, 3,
            "counts include the reserved Unknown player"
        );
        assert_eq!(
            std::fs::read(fixture.path("source")).unwrap(),
            body.as_bytes()
        );
    }

    #[tokio::test]
    async fn app_save_append_delete_and_native_cache_write_refusal() {
        use tauri::Manager;
        let fixture = Fixture::new();
        let original = game(Some("123"), "e4 e5", "original");
        let file = fixture.create("games", &original, WorkspaceFileType::Game);
        let collection = fixture.list().pop().unwrap();
        let first = fixture.rows(&collection).pop().unwrap();
        let locator = first.linked.unwrap();
        let app = fixture.app();
        assert!(write_db_game(
            collection.database.clone().unwrap(),
            first.id,
            game(None, "d4 d5", "stale database writer"),
            app.state::<AppState>()
        )
        .await
        .is_err());
        assert!(matches!(
            pgn::write_game(
                file.clone(),
                0,
                game(None, "c4 c5", "unqualified file write"),
                pgn::WriteExpectation::Game {
                    stamp: locator.stamp.clone()
                },
                app.state::<AppState>()
            )
            .await,
            Err(Error::StaleGame)
        ));
        for operation in [PathOperation::DatabaseCreate, PathOperation::DatabaseMutate] {
            assert!(resolve_database(
                &fixture.state.pgn_path_authority,
                collection.database.as_ref().unwrap(),
                operation
            )
            .is_err());
        }
        let changed = game(Some("123"), "d4 d5", "changed, with $1 and a custom header");
        let resolved = fixture
            .state
            .pgn_path_authority
            .with_mut(|authority| authority.resolve(file.path_ref(), PathOperation::WritePgn, &[]))
            .unwrap()
            .unwrap();
        let written = pgn::write_game_core(
            fixture.state.operations.accept("write_game").unwrap(),
            resolved,
            0,
            changed.clone(),
            pgn::WriteExpectation::LinkedGame {
                stamp: locator.stamp,
                revision: locator.generation,
            },
            fixture.state.pgn_repository.clone(),
            Some(pgn::PgnCapabilityRebind::new(
                fixture.state.pgn_path_authority.clone(),
                &file,
            )),
        )
        .await
        .unwrap();
        assert_eq!(written.linked.as_ref().unwrap().ordinal, 0);
        assert_eq!(
            written.linked.as_ref().unwrap().generation,
            *written.revision.as_ref().unwrap()
        );
        let after = fixture.list().pop().unwrap();
        assert_ne!(collection.generation, after.generation);
        assert_eq!(
            std::fs::read(fixture.path("games")).unwrap(),
            changed.as_bytes()
        );
        let selected = fixture.rows(&after).pop().unwrap().linked.unwrap();
        let resolved = fixture
            .state
            .pgn_path_authority
            .with_mut(|authority| authority.resolve(file.path_ref(), PathOperation::WritePgn, &[]))
            .unwrap()
            .unwrap();
        pgn::delete_game_core(
            fixture.state.operations.accept("delete_game").unwrap(),
            resolved,
            selected.ordinal,
            selected.stamp,
            selected.generation,
            fixture.state.pgn_repository.clone(),
            Some(pgn::PgnCapabilityRebind::new(
                fixture.state.pgn_path_authority.clone(),
                &file,
            )),
        )
        .await
        .unwrap();
        assert!(fixture.rows(&fixture.list().pop().unwrap()).is_empty());
        let appended = pgn::write_game(
            file.clone(),
            0,
            original,
            pgn::WriteExpectation::Append,
            app.state::<AppState>(),
        )
        .await
        .unwrap();
        let locator = appended.linked.unwrap();
        assert_eq!(locator.ordinal, 0);
        assert_eq!(Some(locator.generation.clone()), appended.revision);
        let saved = pgn::write_game(
            file,
            0,
            game(Some("123"), "c4 c5", "edited appended game"),
            pgn::WriteExpectation::LinkedGame {
                stamp: locator.stamp,
                revision: locator.generation,
            },
            app.state::<AppState>(),
        )
        .await
        .unwrap();
        assert!(saved.linked.is_some());
        assert!(fixture.rows(&fixture.list().pop().unwrap())[0]
            .moves
            .contains("c4"));
    }

    #[tokio::test]
    async fn database_only_migration_restart_overlap_restore_and_private_batch_conflict() {
        let mut fixture = Fixture::new();
        let original = game(Some("123"), "e4 e5", "database annotations");
        let database = fixture.reference("account", &original);
        std::fs::remove_file(fixture.path("import-account")).unwrap();
        assert!(
            !fixture.path("import-account").exists(),
            "database-only migration still had its old import PGN"
        );
        let intent = fixture.migration(database.clone(), None, MigrationChoice::Database);
        let migrated = fixture
            .service
            .migrate(
                &fixture.state.pgn_path_authority,
                &fixture.state.workspace_mutation,
                intent.clone(),
                &CancellationToken::new(),
            )
            .unwrap();
        assert!(
            resolve_database(
                &fixture.state.pgn_path_authority,
                &database,
                PathOperation::DatabaseMutate
            )
            .is_err(),
            "retired pre-link database remained writable"
        );
        fixture.restart();
        let id = Uuid::parse_str(&migrated.id).unwrap();
        let batch = fixture.create("batch", &original, WorkspaceFileType::Other);
        let outcome = Arc::clone(&fixture.service)
            .append_batch(
                fixture.state.pgn_path_authority.clone(),
                id,
                batch,
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(
            outcome.appended, 0,
            "ID-bearing provider game duplicated its migrated ID-less occurrence"
        );
        assert!(outcome.committed && outcome.index_ready);
        assert_eq!(fixture.rows(&fixture.list().pop().unwrap()).len(), 1);
        let first = fixture.create(
            "pending-first",
            &game(Some("456"), "d4 d5", "one"),
            WorkspaceFileType::Other,
        );
        let second = fixture.create(
            "pending-second",
            &game(Some("789"), "c4 c5", "two"),
            WorkspaceFileType::Other,
        );
        fixture
            .service
            .stage_batch(
                &fixture.state.pgn_path_authority,
                id,
                first.clone(),
                &CancellationToken::new(),
            )
            .unwrap();
        assert!(
            matches!(
                fixture.service.stage_batch(
                    &fixture.state.pgn_path_authority,
                    id,
                    second,
                    &CancellationToken::new()
                ),
                Err(Error::Conflict(_))
            ),
            "new input silently received the old pending batch"
        );
        fixture.restart();
        let owned = fixture
            .service
            .pending_source(
                &fixture.state.pgn_path_authority,
                id,
                &CancellationToken::new(),
            )
            .unwrap()
            .unwrap();
        assert_ne!(
            owned, first,
            "recovery depends on an overwritten provider download"
        );
        let outcome = Arc::clone(&fixture.service)
            .append_batch(
                fixture.state.pgn_path_authority.clone(),
                id,
                owned,
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(outcome.appended, 1);
        let destination_path = fixture.directory.path().join("restored.db3");
        File::create(&destination_path).unwrap();
        let destination = DatabaseHandle::new(
            fixture
                .state
                .pgn_path_authority
                .with_mut(|authority| {
                    authority.get_or_create_persistent_file(
                        &destination_path,
                        "restored",
                        vec![
                            PathOperation::DatabaseCreate,
                            PathOperation::DatabaseRead,
                            PathOperation::DatabaseMutate,
                        ],
                    )
                })
                .unwrap()
                .unwrap()
                .id,
        );
        fixture
            .service
            .restore_archive(
                &fixture.state.pgn_path_authority,
                id,
                &destination,
                &CancellationToken::new(),
            )
            .unwrap();
        fixture.restart();
        fixture
            .service
            .restore_archive(
                &fixture.state.pgn_path_authority,
                id,
                &destination,
                &CancellationToken::new(),
            )
            .unwrap();
        assert_eq!(
            get_games_blocking(
                &fixture.state.pgn_path_authority,
                &fixture.state.database_repository,
                destination,
                GameQuery::new(),
                &CancellationToken::new()
            )
            .unwrap()
            .data
            .len(),
            1,
            "archive restore lost the original accumulated database"
        );
    }

    #[test]
    fn corrupt_registry_is_preserved_without_inventing_a_source() {
        let mut fixture = Fixture::new();
        fixture.create(
            "games",
            &game(None, "e4 e5", "kept"),
            WorkspaceFileType::Game,
        );
        fixture.list();
        let path = fixture.service.root.path().join(REGISTRY);
        let corrupt = b"{unsupported and incomplete";
        std::fs::write(&path, corrupt).unwrap();
        fixture.restart();
        assert!(fixture
            .service
            .record(Uuid::new_v4(), &CancellationToken::new())
            .is_err());
        assert_eq!(std::fs::read(path).unwrap(), corrupt);
        assert_eq!(
            std::fs::read(fixture.path("games")).unwrap(),
            game(None, "e4 e5", "kept").as_bytes()
        );
        assert_eq!(
            supported(),
            cfg!(any(target_os = "linux", target_os = "macos"))
        );
    }

    #[tokio::test]
    async fn account_preparation_creates_and_reuses_one_source_with_pending_recovery() {
        use tauri::Manager;
        let mut fixture = Fixture::new();
        let app = fixture.app();
        let canonical = AccountIdentity {
            provider: "chesscom".into(),
            account: "player".into(),
        };
        let first = prepare_account_collection(
            fixture.workspace.clone(),
            AccountIdentity {
                account: "Player".into(),
                ..canonical.clone()
            },
            None,
            app.state::<AppState>(),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(!first.migration_required);
        assert!(first.pending_batch.is_none());
        let collection = first.collection.unwrap();
        assert_eq!(collection.account, Some(canonical.clone()));
        assert_eq!(collection.status, CollectionStatus::Ready);
        assert!(collection.database.is_some());
        assert!(collection.retired_database.is_none());
        let id = Uuid::parse_str(&collection.id).unwrap();
        let record = fixture
            .service
            .record(id, &CancellationToken::new())
            .unwrap();
        let source_path = fixture
            .directory
            .path()
            .join("library")
            .join(&record.locator[0]);
        assert_eq!(std::fs::read(&source_path).unwrap(), b"");
        let (listing, _) = crate::file_workspace::collect_tree_entries(
            &fixture.state.pgn_path_authority,
            &fixture.workspace,
            &CancellationToken::new(),
        )
        .unwrap();
        let metadata = selected_metadata(&listing.entries, &collection.file).unwrap();
        assert_eq!(metadata.file_type, WorkspaceFileType::Game);
        assert!(metadata.tags.is_empty());
        assert_eq!(fixture.list().len(), 1);
        assert!(fixture.rows(&collection).is_empty());

        let repeated = prepare_account_collection(
            fixture.workspace.clone(),
            canonical.clone(),
            None,
            app.state::<AppState>(),
        )
        .await;
        assert!(
            repeated.is_ok(),
            "repeated preparation did not reuse existing account authority"
        );
        let repeated = repeated.unwrap().unwrap();
        let repeated = repeated.collection.unwrap();
        assert_eq!(
            repeated.id, collection.id,
            "repeated preparation replaced the account UUID"
        );
        assert_eq!(repeated.file, collection.file);
        assert_eq!(fixture.list().len(), 1);

        let body = game(Some("123"), "e4 e5", "retained pending download");
        let batch = fixture.create("incoming", &body, WorkspaceFileType::Other);
        fixture
            .service
            .stage_batch(
                &fixture.state.pgn_path_authority,
                id,
                batch.clone(),
                &CancellationToken::new(),
            )
            .unwrap();
        drop(app);
        fixture.restart();
        let app = fixture.app();
        let recovered = prepare_account_collection(
            fixture.workspace.clone(),
            canonical.clone(),
            None,
            app.state::<AppState>(),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(!recovered.migration_required);
        let owned = recovered.pending_batch.unwrap();
        assert_ne!(owned, batch);
        let recovered = recovered.collection.unwrap();
        assert_eq!(
            recovered.id, collection.id,
            "restart replaced the account UUID"
        );
        assert_eq!(recovered.file, collection.file);
        assert_eq!(recovered.pending_batch, Some(owned.clone()));
        assert_eq!(fixture.list().len(), 1);
        assert!(std::fs::read(&source_path).unwrap().is_empty());
        assert_eq!(
            std::fs::read(fixture.path("incoming")).unwrap(),
            body.as_bytes()
        );
        let mut snapshot = fixture
            .state
            .pgn_path_authority
            .with_mut(|authority| {
                authority
                    .resolve(owned.path_ref(), PathOperation::ReadPgn, &[])?
                    .pgn_snapshot()
            })
            .unwrap()
            .unwrap();
        let mut retained = vec![];
        snapshot.file.read_to_end(&mut retained).unwrap();
        assert_eq!(retained, body.as_bytes());
        Arc::clone(&fixture.service)
            .append_batch(
                fixture.state.pgn_path_authority.clone(),
                id,
                owned,
                CancellationToken::new(),
            )
            .await
            .unwrap();
        let completed = prepare_account_collection(
            fixture.workspace.clone(),
            canonical,
            None,
            app.state::<AppState>(),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(completed.pending_batch.is_none());
        assert_eq!(completed.collection.as_ref().unwrap().id, collection.id);
        assert_eq!(fixture.list().len(), 1);
        assert_eq!(
            fixture.rows(completed.collection.as_ref().unwrap()).len(),
            1
        );
    }

    async fn refuse_account_activation(
        fixture: &Fixture,
        account: &AccountIdentity,
    ) -> CreationIntent {
        use std::sync::atomic::{AtomicBool, Ordering};
        use tauri::Manager;
        struct RefuseCreatedSourceActivation {
            registry: PathBuf,
            authority_registry: PathBuf,
            library: PathBuf,
            account: AccountIdentity,
            fired: Arc<AtomicBool>,
        }
        impl fs::AtomicWriterInjector for RefuseCreatedSourceActivation {
            fn inject(&self, point: fs::AtomicFileFaultPoint) -> std::io::Result<()> {
                if point != fs::AtomicFileFaultPoint::Rename || !self.registry.exists() {
                    return Ok(());
                }
                let registry: Registry = serde_json::from_slice(&std::fs::read(&self.registry)?)
                    .map_err(std::io::Error::other)?;
                for creation in &registry.creations {
                    if creation.account != self.account {
                        continue;
                    }
                    let cache = self
                        .registry
                        .parent()
                        .unwrap()
                        .join(format!("{}.db3", creation.id));
                    let authority: serde_json::Value =
                        serde_json::from_slice(&std::fs::read(&self.authority_registry)?)
                            .map_err(std::io::Error::other)?;
                    let cache_path = serde_json::to_value(authority::NativePath::from_path(&cache))
                        .map_err(std::io::Error::other)?;
                    let cache_registered = authority["entries"].as_array().is_some_and(|entries| {
                        entries.iter().any(|entry| entry["path"] == cache_path)
                    });
                    let filename = crate::file_workspace::pgn_name(&creation.name)
                        .map_err(std::io::Error::other)?;
                    let sidecar = authority::workspace_sidecar_leaf(OsStr::new(&filename))
                        .map_err(std::io::Error::other)?;
                    if creation.identity.is_some()
                        && cache_registered
                        && self.library.join(&filename).exists()
                        && self.library.join(sidecar).exists()
                        && self
                            .registry
                            .parent()
                            .is_some_and(|root| root.join(format!("{}.db3", creation.id)).exists())
                        && !registry
                            .records
                            .iter()
                            .any(|record| record.id == creation.id)
                    {
                        self.fired.store(true, Ordering::SeqCst);
                        return Err(std::io::Error::other(
                            "refuse activation after account PGN and metadata publication",
                        ));
                    }
                }
                Ok(())
            }
        }
        let fired = Arc::new(AtomicBool::new(false));
        let fault =
            fs::install_test_atomic_file_injector(Arc::new(RefuseCreatedSourceActivation {
                registry: fixture.service.root.path().join(REGISTRY),
                authority_registry: fixture.directory.path().join("authority.json"),
                library: fixture.directory.path().join("library"),
                account: account.clone(),
                fired: Arc::clone(&fired),
            }));
        let app = fixture.app();
        assert!(prepare_account_collection(
            fixture.workspace.clone(),
            account.clone(),
            None,
            app.state::<AppState>()
        )
        .await
        .is_err());
        assert!(
            fired.load(Ordering::SeqCst),
            "fixture did not reach published account source metadata"
        );
        drop(fault);
        drop(app);
        let creation =
            CollectionService::state(&mut fixture.service.lock(&CancellationToken::new()).unwrap())
                .unwrap()
                .creations
                .iter()
                .find(|creation| creation.account == *account)
                .unwrap()
                .clone();
        assert!(creation.identity.is_some());
        creation
    }

    fn created_source_bytes(fixture: &Fixture, creation: &CreationIntent) -> (Vec<u8>, Vec<u8>) {
        let source = fixture.path(&creation.name);
        let metadata = source.with_file_name(
            authority::workspace_sidecar_leaf(source.file_name().unwrap()).unwrap(),
        );
        (
            std::fs::read(source).unwrap(),
            std::fs::read(metadata).unwrap(),
        )
    }

    async fn interrupt_account_before_sidecar(
        fixture: &Fixture,
        account: &AccountIdentity,
    ) -> CreationIntent {
        use std::sync::atomic::{AtomicBool, Ordering};
        use tauri::Manager;
        struct InterruptPublishedPgn {
            registry: PathBuf,
            library: PathBuf,
            account: AccountIdentity,
            fired: Arc<AtomicBool>,
        }
        impl fs::AtomicWriterInjector for InterruptPublishedPgn {
            fn inject(&self, point: fs::AtomicFileFaultPoint) -> std::io::Result<()> {
                if point != fs::AtomicFileFaultPoint::ParentSync || !self.registry.exists() {
                    return Ok(());
                }
                let registry: Registry = serde_json::from_slice(&std::fs::read(&self.registry)?)
                    .map_err(std::io::Error::other)?;
                for creation in &registry.creations {
                    if creation.account != self.account || creation.identity.is_none() {
                        continue;
                    }
                    let filename = crate::file_workspace::pgn_name(&creation.name).unwrap();
                    let sidecar = authority::workspace_sidecar_leaf(OsStr::new(&filename)).unwrap();
                    let source = self.library.join(&filename);
                    if source.exists() && !self.library.join(sidecar).exists() {
                        assert_eq!(
                            authority::opened_file_identity(&File::open(source).unwrap()).unwrap(),
                            creation.identity.unwrap()
                        );
                        self.fired.store(true, Ordering::SeqCst);
                        // Unwind instead of an I/O error so normal creation rollback cannot run.
                        panic!(
                            "induced interruption after PGN publication before sidecar creation"
                        );
                    }
                }
                Ok(())
            }
        }
        let fired = Arc::new(AtomicBool::new(false));
        let fault = fs::install_test_atomic_file_injector(Arc::new(InterruptPublishedPgn {
            registry: fixture.service.root.path().join(REGISTRY),
            library: fixture.directory.path().join("library"),
            account: account.clone(),
            fired: Arc::clone(&fired),
        }));
        let app = fixture.app();
        assert!(matches!(
            prepare_account_collection(
                fixture.workspace.clone(), account.clone(), None, app.state::<AppState>()
            ).await,
            Err(Error::Conflict(message)) if message == "Blocking task panicked"
        ));
        drop(fault);
        assert!(
            fired.load(Ordering::SeqCst),
            "publication interruption did not fire"
        );
        // A fresh process has a new workspace mutex. The fixture retains AppState on restart.
        fixture.state.workspace_mutation.clear_poison();
        let registry =
            CollectionService::state(&mut fixture.service.lock(&CancellationToken::new()).unwrap())
                .unwrap()
                .clone();
        assert!(registry.records.is_empty());
        assert_eq!(registry.creations.len(), 1);
        let creation = registry.creations[0].clone();
        assert_eq!(creation.account, *account);
        assert!(creation.identity.is_some());
        creation
    }

    #[tokio::test]
    async fn native_r2_coordination_live_publishers_preserve_source_and_complete_discovery() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use tauri::Manager;
        struct PausePublishedPgn {
            registry: PathBuf,
            library: PathBuf,
            account: AccountIdentity,
            hook: pgn::BoundedHook,
            paused: AtomicBool,
        }
        impl fs::AtomicWriterInjector for PausePublishedPgn {
            fn inject(&self, point: fs::AtomicFileFaultPoint) -> std::io::Result<()> {
                if point != fs::AtomicFileFaultPoint::ParentSync || !self.registry.exists() {
                    return Ok(());
                }
                let registry: Registry = serde_json::from_slice(&std::fs::read(&self.registry)?)
                    .map_err(std::io::Error::other)?;
                for creation in &registry.creations {
                    if creation.account != self.account || creation.identity.is_none() {
                        continue;
                    }
                    let filename = crate::file_workspace::pgn_name(&creation.name).unwrap();
                    let sidecar = authority::workspace_sidecar_leaf(OsStr::new(&filename)).unwrap();
                    if self.library.join(filename).exists()
                        && !self.library.join(sidecar).exists()
                        && !self.paused.swap(true, Ordering::SeqCst)
                    {
                        self.hook.notify_and_wait();
                    }
                }
                Ok(())
            }
        }
        for provider in ["chesscom", "lichess"] {
            for linked_first in [false, true] {
                let fixture = Fixture::new();
                let account = AccountIdentity {
                    provider: provider.into(),
                    account: "player".into(),
                };
                let (hook, entered, release) = pgn::BoundedHook::new();
                let injector = Arc::new(PausePublishedPgn {
                    registry: fixture.service.root.path().join(REGISTRY),
                    library: fixture.directory.path().join("library"),
                    account: account.clone(),
                    hook,
                    paused: AtomicBool::new(false),
                });
                let app = fixture.app();
                let workspace = fixture.workspace.clone();
                let creator_account = account.clone();
                let creator = tokio::spawn(async move {
                    let _fault = fs::install_test_atomic_file_injector(injector);
                    prepare_account_collection(
                        workspace,
                        creator_account,
                        None,
                        app.state::<AppState>(),
                    )
                    .await
                });
                tokio::time::timeout(Duration::from_secs(10), entered)
                    .await
                    .unwrap()
                    .unwrap();
                let registry: Registry = serde_json::from_slice(
                    &std::fs::read(fixture.service.root.path().join(REGISTRY)).unwrap(),
                )
                .unwrap();
                assert!(registry.records.is_empty());
                let creation = registry.creations.first().unwrap().clone();
                assert_eq!(creation.account, account);
                let source = fixture.path(&creation.name);
                let sidecar = source.with_file_name(
                    authority::workspace_sidecar_leaf(source.file_name().unwrap()).unwrap(),
                );
                let original = std::fs::read(&source).unwrap();
                assert_eq!(
                    creation.identity,
                    Some(authority::opened_file_identity(&File::open(&source).unwrap()).unwrap())
                );
                let (stale, _) = crate::file_workspace::collect_tree_entries(
                    &fixture.state.pgn_path_authority,
                    &fixture.workspace,
                    &CancellationToken::new(),
                )
                .unwrap();
                assert_eq!(
                    stale.entries[0].metadata.as_ref().unwrap().file_type,
                    WorkspaceFileType::Other
                );
                assert!(!sidecar.exists());
                let waiting = crate::infra::cancellable_lock::observe_std_lock_wait(
                    fixture.state.workspace_mutation.as_ref(),
                );
                let (events, mut received) = tokio::sync::mpsc::unbounded_channel();
                let wait_events = events.clone();
                let observer = tokio::task::spawn_blocking(move || {
                    if waiting.recv_timeout(Duration::from_secs(10)).is_ok() {
                        let _ = wait_events.send("workspace owner contended");
                    }
                });
                let authority = fixture.state.pgn_path_authority.clone();
                let repository = fixture.state.pgn_repository.clone();
                let workspace = fixture.workspace.clone();
                let discovery = tokio::spawn(async move {
                    let token = CancellationToken::new();
                    let result = if linked_first {
                        list_linked_collections_core(
                            Some(workspace),
                            &authority,
                            &repository,
                            &token,
                        )
                        .await
                        .map(|_| ())
                    } else {
                        crate::file_workspace::list_file_workspace_core(
                            &workspace,
                            &authority,
                            &repository,
                            &token,
                        )
                        .await
                        .map(|listing| {
                            assert_eq!(
                                listing.entries[0].metadata.as_ref().unwrap().file_type,
                                WorkspaceFileType::Game,
                                "complete workspace discovery returned stale metadata"
                            );
                        })
                    };
                    let _ = events.send("complete discovery finished");
                    result
                });
                // Either real contention or completed uncoordinated recovery releases the
                // original publisher. No elapsed delay chooses the semantic outcome.
                let event = tokio::time::timeout(Duration::from_secs(10), received.recv())
                    .await
                    .unwrap()
                    .unwrap();
                release.send(()).unwrap();
                let created = tokio::time::timeout(Duration::from_secs(10), creator)
                    .await
                    .unwrap()
                    .unwrap();
                let discovered = tokio::time::timeout(Duration::from_secs(10), discovery)
                    .await
                    .unwrap()
                    .unwrap();
                observer.await.unwrap();
                assert!(
                    created.is_ok(),
                    "live creator rolled back its published source after discovery: {:?}",
                    created.as_ref().err().map(Error::diagnostic)
                );
                assert!(
                    discovered.is_ok(),
                    "concurrent discovery refused the live publisher"
                );
                assert_eq!(event, "workspace owner contended");
                let owner = created.unwrap().unwrap().collection.unwrap();
                assert_eq!(owner.id, creation.id.to_string());
                assert_eq!(owner.account, Some(account.clone()));
                assert_eq!(owner.status, CollectionStatus::Ready);
                assert!(
                    fixture.rows(&owner).is_empty(),
                    "empty source index is usable"
                );
                assert_eq!(std::fs::read(&source).unwrap(), original);
                let expected = serde_json::to_vec(&WorkspaceMetadata {
                    file_type: WorkspaceFileType::Game,
                    tags: vec![],
                })
                .unwrap();
                assert_eq!(std::fs::read(&sidecar).unwrap(), expected);
                let custom =
                    b"{\n \"tags\": [\"retained live annotation\"], \"type\": \"game\"\n}\n";
                std::fs::write(&sidecar, custom).unwrap();
                for _ in 0..3 {
                    let listing = crate::file_workspace::list_file_workspace_core(
                        &fixture.workspace,
                        &fixture.state.pgn_path_authority,
                        &fixture.state.pgn_repository,
                        &CancellationToken::new(),
                    )
                    .await
                    .unwrap();
                    assert_eq!(
                        listing.entries[0].metadata.as_ref().unwrap().file_type,
                        WorkspaceFileType::Game
                    );
                    let collections = list_linked_collections_core(
                        Some(fixture.workspace.clone()),
                        &fixture.state.pgn_path_authority,
                        &fixture.state.pgn_repository,
                        &CancellationToken::new(),
                    )
                    .await
                    .unwrap();
                    assert_eq!(collections.len(), 1);
                    assert_eq!(collections[0].id, owner.id);
                    assert_eq!(collections[0].account, Some(account.clone()));
                    assert_eq!(collections[0].status, CollectionStatus::Ready);
                    assert!(fixture.rows(&collections[0]).is_empty());
                    assert_eq!(std::fs::read(&source).unwrap(), original);
                    assert_eq!(std::fs::read(&sidecar).unwrap(), custom);
                }
                let incoming = fixture.create(
                    "incoming",
                    &game(None, "e4 e5", "query the recovered index"),
                    WorkspaceFileType::Other,
                );
                let appended = Arc::clone(&fixture.service)
                    .append_batch(
                        fixture.state.pgn_path_authority.clone(),
                        creation.id,
                        incoming,
                        CancellationToken::new(),
                    )
                    .await
                    .unwrap();
                assert_eq!(appended.appended, 1);
                let collections = list_linked_collections_core(
                    Some(fixture.workspace.clone()),
                    &fixture.state.pgn_path_authority,
                    &fixture.state.pgn_repository,
                    &CancellationToken::new(),
                )
                .await
                .unwrap();
                assert_eq!(collections.len(), 1);
                assert_eq!(collections[0].status, CollectionStatus::Ready);
                assert_eq!(
                    fixture.rows(&collections[0]).len(),
                    1,
                    "complete discovery did not expose a usable current index"
                );
                assert_eq!(std::fs::read(&sidecar).unwrap(), custom);
            }
        }
    }

    #[tokio::test]
    async fn native_r2_coordination_cancellation_preserves_pending_publication() {
        let fixture = Fixture::new();
        let creation = interrupt_account_before_sidecar(
            &fixture,
            &AccountIdentity {
                provider: "lichess".into(),
                account: "player".into(),
            },
        )
        .await;
        let source = fixture.path(&creation.name);
        let sidecar = source.with_file_name(
            authority::workspace_sidecar_leaf(source.file_name().unwrap()).unwrap(),
        );
        let registry = fixture.service.root.path().join(REGISTRY);
        let before = (
            std::fs::read(&source).unwrap(),
            std::fs::read(&registry).unwrap(),
        );
        let token = CancellationToken::new();
        let _cancel_on_drop = token.clone().drop_guard();
        let holder_token = token.clone();
        let workspace_mutation = Arc::clone(&fixture.state.workspace_mutation);
        let (acquired, acquired_rx) = tokio::sync::oneshot::channel();
        let (release, release_rx) = std::sync::mpsc::sync_channel(1);
        let holder = tokio::task::spawn_blocking(move || {
            let held = crate::infra::cancellable_lock::lock_std_cancellable(
                &workspace_mutation,
                &holder_token,
                "workspace mutation lock was poisoned",
            )?;
            if acquired.send(()).is_err() {
                return Ok(());
            }
            let released = release_rx.recv_timeout(Duration::from_secs(10));
            drop(held);
            released.map_err(|error| {
                Error::Conflict(format!("test workspace holder release failed: {error}"))
            })
        });
        tokio::time::timeout(Duration::from_secs(10), acquired_rx)
            .await
            .unwrap()
            .unwrap();
        let waiting = crate::infra::cancellable_lock::observe_std_lock_wait(
            fixture.state.workspace_mutation.as_ref(),
        );
        let worker_token = token.clone();
        let authority = fixture.state.pgn_path_authority.clone();
        let repository = fixture.state.pgn_repository.clone();
        let workspace = fixture.workspace.clone();
        let discovery = tokio::spawn(async move {
            crate::file_workspace::list_file_workspace_core(
                &workspace,
                &authority,
                &repository,
                &worker_token,
            )
            .await
        });
        tokio::task::spawn_blocking(move || waiting.recv_timeout(Duration::from_secs(10)))
            .await
            .unwrap()
            .unwrap();
        token.cancel();
        let result = tokio::time::timeout(Duration::from_secs(10), discovery)
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(result, Err(Error::Cancellation)));
        assert!(!sidecar.exists());
        assert_eq!(
            (
                std::fs::read(&source).unwrap(),
                std::fs::read(&registry).unwrap()
            ),
            before
        );
        release.send(()).unwrap();
        holder.await.unwrap().unwrap();
        let listing = crate::file_workspace::list_file_workspace_core(
            &fixture.workspace,
            &fixture.state.pgn_path_authority,
            &fixture.state.pgn_repository,
            &CancellationToken::new(),
        )
        .await
        .unwrap();
        assert_eq!(
            listing.entries[0].metadata.as_ref().unwrap().file_type,
            WorkspaceFileType::Game
        );
        assert_eq!(fixture.list()[0].id, creation.id.to_string());
    }

    #[tokio::test]
    async fn native_r2_coordination_uses_current_metadata_after_real_purpose_changes() {
        use tauri::Manager;
        for provider in ["chesscom", "lichess"] {
            let fixture = Fixture::new();
            let account = AccountIdentity {
                provider: provider.into(),
                account: "player".into(),
            };
            let creation = interrupt_account_before_sidecar(&fixture, &account).await;
            let (before_publication, _) = crate::file_workspace::collect_tree_entries(
                &fixture.state.pgn_path_authority,
                &fixture.workspace,
                &CancellationToken::new(),
            )
            .unwrap();
            assert_eq!(
                before_publication.entries[0]
                    .metadata
                    .as_ref()
                    .unwrap()
                    .file_type,
                WorkspaceFileType::Other
            );
            let listing = crate::file_workspace::list_file_workspace_core(
                &fixture.workspace,
                &fixture.state.pgn_path_authority,
                &fixture.state.pgn_repository,
                &CancellationToken::new(),
            )
            .await
            .unwrap();
            assert_eq!(
                listing.entries[0].metadata.as_ref().unwrap().file_type,
                WorkspaceFileType::Game,
                "recovered workspace view retained stale Other metadata"
            );
            assert!(CollectionService::state(
                &mut fixture.service.lock(&CancellationToken::new()).unwrap()
            )
            .unwrap()
            .creations
            .is_empty());
            let reconciled = fixture
                .service
                .reconcile(
                    &fixture.state.pgn_path_authority,
                    &fixture.workspace,
                    &CancellationToken::new(),
                )
                .unwrap();
            assert_eq!(reconciled.len(), 1);
            assert_eq!(reconciled[0].id, creation.id.to_string());
            assert_eq!(reconciled[0].account, Some(account));
            assert_eq!(
                reconciled[0].status,
                CollectionStatus::Ready,
                "reconciliation retired a current Game collection after intent retirement"
            );
            assert!(reconciled[0].database.is_some());
            assert!(fixture.rows(&reconciled[0]).is_empty());
            let source_before = std::fs::read(fixture.path(&creation.name)).unwrap();
            let app = fixture.app();
            crate::file_workspace::write_workspace_file_metadata(
                fixture.workspace.clone(),
                reconciled[0].file.clone(),
                WorkspaceMetadata {
                    file_type: WorkspaceFileType::Repertoire,
                    tags: vec!["intentional current purpose".into()],
                },
                app.state::<AppState>(),
            )
            .await
            .unwrap();
            let current = fixture
                .service
                .reconcile(
                    &fixture.state.pgn_path_authority,
                    &fixture.workspace,
                    &CancellationToken::new(),
                )
                .unwrap();
            assert_eq!(
                current[0].status,
                CollectionStatus::Retired,
                "reconciliation ignored a real current purpose change"
            );
            assert!(current[0].database.is_none());
            let listing = crate::file_workspace::list_file_workspace_core(
                &fixture.workspace,
                &fixture.state.pgn_path_authority,
                &fixture.state.pgn_repository,
                &CancellationToken::new(),
            )
            .await
            .unwrap();
            assert_eq!(
                listing.entries[0].metadata.as_ref().unwrap().file_type,
                WorkspaceFileType::Repertoire
            );
            assert_eq!(
                std::fs::read(fixture.path(&creation.name)).unwrap(),
                source_before
            );
        }
    }

    #[tokio::test]
    async fn native_r2_missing_sidecar_recovers_both_restart_orders_and_providers() {
        use std::os::unix::fs::PermissionsExt;
        use tauri::Manager;
        for provider in ["chesscom", "lichess"] {
            for discovery_first in [false, true] {
                for custom_metadata in [false, true] {
                    let mut fixture = Fixture::new();
                    let plain_body = game(None, "d4 d5", "unrelated plain PGN");
                    fixture.create("plain", &plain_body, WorkspaceFileType::Other);
                    let plain = fixture.path("plain");
                    let plain_sidecar = plain.with_file_name(
                        authority::workspace_sidecar_leaf(plain.file_name().unwrap()).unwrap(),
                    );
                    std::fs::remove_file(&plain_sidecar).unwrap();
                    let account = AccountIdentity {
                        provider: provider.into(),
                        account: "player".into(),
                    };
                    let creation = interrupt_account_before_sidecar(&fixture, &account).await;
                    let permissions = std::fs::metadata(&plain).unwrap().permissions();
                    std::fs::set_permissions(&plain, std::fs::Permissions::from_mode(0o000))
                        .unwrap();
                    assert_eq!(
                        File::open(&plain).unwrap_err().kind(),
                        std::io::ErrorKind::PermissionDenied
                    );
                    let source = fixture.path(&creation.name);
                    let sidecar = source.with_file_name(
                        authority::workspace_sidecar_leaf(source.file_name().unwrap()).unwrap(),
                    );
                    let original = std::fs::read(&source).unwrap();
                    assert!(!sidecar.exists());
                    let custom = b"{\n \"tags\": [\"custom annotation\"], \"type\": \"game\"\n}\n";
                    if custom_metadata {
                        std::fs::write(&sidecar, custom).unwrap();
                    }
                    fixture.restart();
                    if discovery_first {
                        let discovered = fixture.list();
                        assert_eq!(discovered.len(), 1);
                        assert_eq!(discovered[0].id, creation.id.to_string());
                        assert_eq!(discovered[0].account, Some(account.clone()));
                    }
                    for _ in 0..3 {
                        let app = fixture.app();
                        let result = prepare_account_collection(
                            fixture.workspace.clone(),
                            account.clone(),
                            None,
                            app.state::<AppState>(),
                        )
                        .await;
                        assert!(
                            result.is_ok(),
                            "missing-sidecar recovery refused: {:?}",
                            result.as_ref().err().map(Error::diagnostic)
                        );
                        let owner = result.unwrap().unwrap().collection.unwrap();
                        assert_eq!(owner.id, creation.id.to_string());
                        assert_eq!(owner.account, Some(account.clone()));
                        let listed = fixture.list();
                        assert_eq!(listed.len(), 1, "recovery activated more than one owner");
                        assert_eq!(listed[0].id, owner.id);
                        assert_eq!(std::fs::read(&source).unwrap(), original);
                        if custom_metadata {
                            assert_eq!(std::fs::read(&sidecar).unwrap(), custom);
                        } else {
                            let metadata: WorkspaceMetadata =
                                serde_json::from_slice(&std::fs::read(&sidecar).unwrap()).unwrap();
                            assert_eq!(metadata.file_type, WorkspaceFileType::Game);
                        }
                        assert!(CollectionService::state(
                            &mut fixture.service.lock(&CancellationToken::new()).unwrap()
                        )
                        .unwrap()
                        .creations
                        .is_empty());
                        drop(app);
                        fixture.restart();
                    }
                    std::fs::set_permissions(&plain, permissions).unwrap();
                    assert_eq!(std::fs::read(plain).unwrap(), plain_body.as_bytes());
                    assert!(
                        !plain_sidecar.exists(),
                        "recovery reclassified an unrelated plain PGN"
                    );
                }
            }
        }
    }

    #[tokio::test]
    async fn native_r2_missing_sidecar_refuses_changed_identity_and_existing_invalid_metadata() {
        use std::os::unix::fs::PermissionsExt;
        use tauri::Manager;
        for scenario in [
            "other",
            "repertoire",
            "malformed",
            "unreadable",
            "permission",
            "identity",
        ] {
            for discovery_first in [false, true] {
                let mut fixture = Fixture::new();
                let account = AccountIdentity {
                    provider: "lichess".into(),
                    account: "player".into(),
                };
                let creation = interrupt_account_before_sidecar(&fixture, &account).await;
                let source = fixture.path(&creation.name);
                let sidecar = source.with_file_name(
                    authority::workspace_sidecar_leaf(source.file_name().unwrap()).unwrap(),
                );
                let held_source = File::open(&source).unwrap();
                match scenario {
                    "identity" => {
                        std::fs::remove_file(&source).unwrap();
                        std::fs::write(&source, game(None, "d4 d5", "replacement must survive"))
                            .unwrap();
                        assert_ne!(
                            authority::opened_file_identity(&held_source).unwrap(),
                            authority::opened_file_identity(&File::open(&source).unwrap()).unwrap()
                        );
                    }
                    "unreadable" => {
                        std::fs::create_dir(&sidecar).unwrap();
                    }
                    "malformed" => {
                        std::fs::write(&sidecar, b"invalid metadata\n").unwrap();
                    }
                    "permission" => {
                        std::fs::write(&sidecar, b"{\"type\":\"game\",\"tags\":[\"private\"]}\n")
                            .unwrap();
                    }
                    purpose => {
                        std::fs::write(
                            &sidecar,
                            format!("{{\"type\":\"{purpose}\",\"tags\":[\"preserve\"]}}\n"),
                        )
                        .unwrap();
                    }
                }
                let source_before = std::fs::read(&source).unwrap();
                let metadata_before = std::fs::read(&sidecar).ok();
                if scenario == "permission" {
                    std::fs::set_permissions(&sidecar, std::fs::Permissions::from_mode(0o000))
                        .unwrap();
                    assert_eq!(
                        File::open(&sidecar).unwrap_err().kind(),
                        std::io::ErrorKind::PermissionDenied
                    );
                }
                let registry_path = fixture.service.root.path().join(REGISTRY);
                let registry_before = std::fs::read(&registry_path).unwrap();
                fixture.restart();
                if discovery_first {
                    let token = CancellationToken::new();
                    let discovery = fixture.service.reconcile(
                        &fixture.state.pgn_path_authority,
                        &fixture.workspace,
                        &token,
                    );
                    assert!(
                        discovery.is_err(),
                        "discovery accepted incompatible {scenario}"
                    );
                }
                let app = fixture.app();
                assert!(
                    prepare_account_collection(
                        fixture.workspace.clone(),
                        account,
                        None,
                        app.state::<AppState>()
                    )
                    .await
                    .is_err(),
                    "preparation accepted incompatible {scenario}"
                );
                assert_eq!(std::fs::read(&source).unwrap(), source_before);
                if scenario == "permission" {
                    std::fs::set_permissions(&sidecar, std::fs::Permissions::from_mode(0o600))
                        .unwrap();
                }
                assert_eq!(std::fs::read(&sidecar).ok(), metadata_before);
                assert_eq!(sidecar.is_dir(), scenario == "unreadable");
                assert_eq!(sidecar.exists(), scenario != "identity");
                assert_eq!(std::fs::read(registry_path).unwrap(), registry_before);
            }
        }
    }

    #[test]
    fn native_r2_destination_recovery_preserves_existing_sidecar_bytes() {
        for purpose in [
            WorkspaceFileType::Game,
            WorkspaceFileType::Other,
            WorkspaceFileType::Repertoire,
        ] {
            let fixture = Fixture::new();
            let file = fixture.create(
                "destination",
                &game(None, "e4 e5", "preserve source"),
                purpose.clone(),
            );
            let target = fixture
                .state
                .pgn_path_authority
                .with_mut(|authority| authority.workspace_mutation_target(&file))
                .unwrap()
                .unwrap();
            let source = fixture.path("destination");
            let sidecar = source.with_file_name(
                authority::workspace_sidecar_leaf(source.file_name().unwrap()).unwrap(),
            );
            let before = (
                std::fs::read(&source).unwrap(),
                std::fs::read(&sidecar).unwrap(),
            );
            let result = fixture.service.recover_created_file(
                &fixture.state.pgn_path_authority,
                &fixture.state.workspace_mutation,
                &fixture.workspace,
                "destination",
                Some(target.identity),
                &CancellationToken::new(),
            );
            assert_eq!(result.is_ok(), purpose == WorkspaceFileType::Game);
            assert_eq!(
                (
                    std::fs::read(source).unwrap(),
                    std::fs::read(sidecar).unwrap()
                ),
                before,
                "destination recovery rewrote an existing sidecar"
            );
        }
    }

    #[tokio::test]
    async fn native_r2_missing_sidecar_conflicting_migration_owner_refuses_before_publication() {
        use tauri::Manager;
        for discovery_first in [false, true] {
            let mut fixture = Fixture::new();
            let account = AccountIdentity {
                provider: "chesscom".into(),
                account: "player".into(),
            };
            let creation = interrupt_account_before_sidecar(&fixture, &account).await;
            let body = game(None, "e4 e5", "independent migration owner");
            let source = fixture.create("independent", &body, WorkspaceFileType::Game);
            let database = fixture.reference("independent", &body);
            let intent = fixture.migration(database, Some(source), MigrationChoice::Pgn);
            let owner = fixture
                .service
                .migrate(
                    &fixture.state.pgn_path_authority,
                    &fixture.state.workspace_mutation,
                    intent,
                    &CancellationToken::new(),
                )
                .unwrap();
            assert_ne!(owner.id, creation.id.to_string());
            assert_eq!(owner.account, Some(account.clone()));
            let source = fixture.path(&creation.name);
            let sidecar = source.with_file_name(
                authority::workspace_sidecar_leaf(source.file_name().unwrap()).unwrap(),
            );
            let source_before = std::fs::read(&source).unwrap();
            let registry = fixture.service.root.path().join(REGISTRY);
            let registry_before = std::fs::read(&registry).unwrap();
            assert!(!sidecar.exists());
            fixture.restart();
            if discovery_first {
                let token = CancellationToken::new();
                assert!(matches!(
                    fixture.service.reconcile(
                        &fixture.state.pgn_path_authority,
                        &fixture.workspace,
                        &token
                    ),
                    Err(Error::Conflict(_))
                ));
            }
            let app = fixture.app();
            assert!(matches!(
                prepare_account_collection(
                    fixture.workspace.clone(),
                    account,
                    None,
                    app.state::<AppState>()
                )
                .await,
                Err(Error::Conflict(_))
            ));
            assert!(
                !sidecar.exists(),
                "conflicting owner recovery wrote a sidecar"
            );
            assert_eq!(std::fs::read(source).unwrap(), source_before);
            assert_eq!(std::fs::read(registry).unwrap(), registry_before);
            assert_eq!(
                std::fs::read(fixture.path("independent")).unwrap(),
                body.as_bytes()
            );
        }
    }

    #[tokio::test]
    async fn account_preparation_recovers_created_source_after_refusal_and_reconciliation() {
        use tauri::Manager;
        let mut fixture = Fixture::new();
        let account = AccountIdentity {
            provider: "chesscom".into(),
            account: "player".into(),
        };
        let creation = refuse_account_activation(&fixture, &account).await;
        let source = fixture.path(&creation.name);
        let published = created_source_bytes(&fixture, &creation);
        assert!(published.0.is_empty());
        fixture.restart();
        let discovered = fixture.list();
        assert_eq!(discovered.len(), 1);
        assert_eq!(
            discovered[0].id,
            creation.id.to_string(),
            "discovery replaced the durable creation UUID"
        );
        assert_eq!(discovered[0].account, Some(account.clone()));
        let app = fixture.app();
        let retry = prepare_account_collection(
            fixture.workspace.clone(),
            account.clone(),
            None,
            app.state::<AppState>(),
        )
        .await;
        assert!(
            retry.is_ok(),
            "account creation recovery refused its previously published source"
        );
        let recovered = retry.unwrap().unwrap().collection.unwrap();
        assert_eq!(recovered.id, creation.id.to_string());
        assert_eq!(recovered.account, Some(account.clone()));
        let active = fixture.list();
        assert_eq!(
            active.len(), 1,
            "account preparation and startup reconciliation activated two identities for one source. registry={}",
            std::fs::read_to_string(fixture.service.root.path().join(REGISTRY)).unwrap()
        );
        assert_eq!(created_source_bytes(&fixture, &creation), published);
        assert!(
            CollectionService::state(&mut fixture.service.lock(&CancellationToken::new()).unwrap())
                .unwrap()
                .creations
                .is_empty(),
            "creation intent was not atomically retired with its single owner"
        );
        drop(app);
        std::fs::remove_file(
            fixture
                .service
                .root
                .path()
                .join(format!("{}.db3", creation.id)),
        )
        .unwrap();
        fixture.restart();
        for _ in 0..2 {
            let listed = fixture.list();
            assert_eq!(listed.len(), 1);
            assert_eq!(listed[0].id, recovered.id);
            assert_eq!(listed[0].file, recovered.file);
            assert_eq!(listed[0].status, CollectionStatus::Ready);
            let app = fixture.app();
            let prepared = prepare_account_collection(
                fixture.workspace.clone(),
                account.clone(),
                None,
                app.state::<AppState>(),
            )
            .await
            .unwrap()
            .unwrap();
            assert_eq!(prepared.collection.unwrap().id, recovered.id);
            assert_eq!(created_source_bytes(&fixture, &creation), published);
            drop(app);
            fixture.restart();
        }
        assert!(std::fs::read(source).unwrap().is_empty());
        let sources: Vec<_> = std::fs::read_dir(fixture.directory.path().join("library"))
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| path.extension().is_some_and(|extension| extension == "pgn"))
            .collect();
        assert_eq!(sources.len(), 1, "recovery created another account source");
    }

    #[tokio::test]
    async fn account_preparation_retries_refused_recovery_without_rewriting_metadata() {
        use tauri::Manager;
        let mut fixture = Fixture::new();
        let account = AccountIdentity {
            provider: "chesscom".into(),
            account: "player".into(),
        };
        let creation = refuse_account_activation(&fixture, &account).await;
        let (listing, _) = crate::file_workspace::collect_tree_entries(
            &fixture.state.pgn_path_authority,
            &fixture.workspace,
            &CancellationToken::new(),
        )
        .unwrap();
        let file = listing
            .entries
            .iter()
            .find(|entry| entry.name == creation.name)
            .unwrap()
            .handle
            .clone();
        crate::file_workspace::write_workspace_file_metadata_blocking(
            fixture.workspace.clone(),
            file,
            WorkspaceMetadata {
                file_type: WorkspaceFileType::Game,
                tags: vec!["retained account annotation".into()],
            },
            &fixture.state.pgn_path_authority,
            &fixture.state.workspace_mutation,
            &CancellationToken::new(),
        )
        .unwrap();
        let published = created_source_bytes(&fixture, &creation);
        fixture.restart();
        let retry = refuse_account_activation(&fixture, &account).await;
        assert_eq!(retry.id, creation.id);
        assert_eq!(retry.identity, creation.identity);
        assert_eq!(created_source_bytes(&fixture, &creation), published);
        fixture.restart();
        let app = fixture.app();
        let recovered = prepare_account_collection(
            fixture.workspace.clone(),
            account.clone(),
            None,
            app.state::<AppState>(),
        )
        .await
        .unwrap()
        .unwrap()
        .collection
        .unwrap();
        assert_eq!(recovered.id, creation.id.to_string());
        assert_eq!(recovered.account, Some(account));
        assert_eq!(fixture.list().len(), 1);
        assert_eq!(created_source_bytes(&fixture, &creation), published);

        let unrelated = fixture.create(
            "ordinary",
            &game(None, "d4 d5", "ordinary discovery"),
            WorkspaceFileType::Game,
        );
        let original = std::fs::read(fixture.path("ordinary")).unwrap();
        let listed = fixture.list();
        assert_eq!(listed.len(), 2);
        let ordinary = listed
            .iter()
            .find(|record| record.file == unrelated)
            .unwrap();
        assert_ne!(ordinary.id, recovered.id);
        assert_eq!(ordinary.account, None);
        assert_eq!(ordinary.status, CollectionStatus::Ready);
        assert_eq!(std::fs::read(fixture.path("ordinary")).unwrap(), original);
        assert_eq!(created_source_bytes(&fixture, &creation), published);
    }

    #[tokio::test]
    async fn account_creation_recovery_does_not_read_unrelated_plain_pgns() {
        use std::os::unix::fs::PermissionsExt;
        for recovering in [false, true] {
            let fixture = Fixture::new();
            let creation = if recovering {
                Some(
                    refuse_account_activation(
                        &fixture,
                        &AccountIdentity {
                            provider: "chesscom".into(),
                            account: "player".into(),
                        },
                    )
                    .await,
                )
            } else {
                fixture.create(
                    "ordinary",
                    &game(None, "e4 e5", "ordinary collection"),
                    WorkspaceFileType::Game,
                );
                None
            };
            let body = game(None, "d4 d5", "plain file must remain independent");
            let plain = fixture.create("plain", &body, WorkspaceFileType::Other);
            let token = CancellationToken::new();
            let (listing, _) = crate::file_workspace::collect_tree_entries(
                &fixture.state.pgn_path_authority,
                &fixture.workspace,
                &token,
            )
            .unwrap();
            let path = fixture.path("plain");
            let permissions = std::fs::metadata(&path).unwrap().permissions();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o000)).unwrap();
            let probe = File::open(&path);
            if probe.is_ok() {
                // Privileged users cannot create this read-refusal fixture.
                std::fs::set_permissions(&path, permissions).unwrap();
                continue;
            }
            assert_eq!(
                probe.unwrap_err().kind(),
                std::io::ErrorKind::PermissionDenied
            );
            let result = fixture.service.reconcile(
                &fixture.state.pgn_path_authority,
                &fixture.workspace,
                &token,
            );
            std::fs::set_permissions(&path, permissions).unwrap();
            assert!(
                result.is_ok(),
                "ordinary discovery tried to read an inactive plain PGN: {:?}",
                result.as_ref().err().map(Error::diagnostic)
            );
            let collections = result.unwrap();
            assert_eq!(collections.len(), 1);
            assert_ne!(collections[0].file, plain);
            assert_eq!(collections[0].status, CollectionStatus::Ready);
            if let Some(creation) = creation {
                assert_eq!(collections[0].id, creation.id.to_string());
                assert_eq!(collections[0].account, Some(creation.account));
            } else {
                assert_eq!(collections[0].account, None);
            }
            assert_eq!(std::fs::read(path).unwrap(), body.as_bytes());
            assert_eq!(
                selected_metadata(&listing.entries, &plain)
                    .unwrap()
                    .file_type,
                WorkspaceFileType::Other
            );
        }
    }

    #[tokio::test]
    async fn account_creation_recovery_refuses_an_existing_migration_account_owner() {
        use tauri::Manager;
        let mut fixture = Fixture::new();
        let account = AccountIdentity {
            provider: "chesscom".into(),
            account: "player".into(),
        };
        let creation = refuse_account_activation(&fixture, &account).await;
        let published = created_source_bytes(&fixture, &creation);
        let body = game(None, "e4 e5", "independently owned history");
        let source = fixture.create("independent", &body, WorkspaceFileType::Game);
        let database = fixture.reference("independent", &body);
        let intent = fixture.migration(database, Some(source), MigrationChoice::Pgn);
        let owner = fixture
            .service
            .migrate(
                &fixture.state.pgn_path_authority,
                &fixture.state.workspace_mutation,
                intent,
                &CancellationToken::new(),
            )
            .unwrap();
        assert_ne!(owner.id, creation.id.to_string());
        assert_eq!(owner.account, Some(account.clone()));
        let incoming = fixture.create(
            "incoming",
            &game(Some("123"), "e4 e5", "pending provider input"),
            WorkspaceFileType::Other,
        );
        let owner_id = Uuid::parse_str(&owner.id).unwrap();
        let matched = Arc::clone(&fixture.service)
            .append_batch(
                fixture.state.pgn_path_authority.clone(),
                owner_id,
                incoming,
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(matched.appended, 0);
        let evidence_path = fixture
            .service
            .root
            .path()
            .join(format!("{owner_id}-identity.db3"));
        let before_evidence = std::fs::read(&evidence_path).unwrap();
        let incoming_body = game(Some("456"), "d4 d5", "retained pending input");
        let incoming = fixture.create("pending", &incoming_body, WorkspaceFileType::Other);
        fixture
            .service
            .stage_batch(
                &fixture.state.pgn_path_authority,
                Uuid::parse_str(&owner.id).unwrap(),
                incoming,
                &CancellationToken::new(),
            )
            .unwrap();
        let registry_path = fixture.service.root.path().join(REGISTRY);
        let before_registry = std::fs::read(&registry_path).unwrap();
        let pending = fixture
            .service
            .record(owner_id, &CancellationToken::new())
            .unwrap()
            .pending
            .unwrap();
        let pending_path = fixture
            .service
            .root
            .path()
            .join(format!("{}-batch.pgn", pending.id));
        let before_pending = std::fs::read(&pending_path).unwrap();
        drop(owner);
        fixture.restart();
        let app = fixture.app();
        let refused = prepare_account_collection(
            fixture.workspace.clone(),
            account,
            None,
            app.state::<AppState>(),
        )
        .await;
        assert!(
            matches!(refused, Err(Error::Conflict(_))),
            "recovery silently accepted a different account owner"
        );
        assert_eq!(std::fs::read(&registry_path).unwrap(), before_registry);
        assert_eq!(created_source_bytes(&fixture, &creation), published);
        assert_eq!(std::fs::read(&evidence_path).unwrap(), before_evidence);
        assert_eq!(std::fs::read(&pending_path).unwrap(), before_pending);
        assert_eq!(
            std::fs::read(fixture.path("pending")).unwrap(),
            incoming_body.as_bytes()
        );
        assert_eq!(
            std::fs::read(fixture.path("independent")).unwrap(),
            body.as_bytes()
        );
        assert!(matches!(
            fixture.service.reconcile(
                &fixture.state.pgn_path_authority,
                &fixture.workspace,
                &CancellationToken::new()
            ),
            Err(Error::Conflict(_))
        ));
        assert_eq!(std::fs::read(&registry_path).unwrap(), before_registry);
        assert_eq!(created_source_bytes(&fixture, &creation), published);
        assert_eq!(std::fs::read(&evidence_path).unwrap(), before_evidence);
        assert_eq!(std::fs::read(&pending_path).unwrap(), before_pending);
    }

    async fn assert_created_account_recovers_after_restart(cache_lost: bool, replaced: bool) {
        use tauri::Manager;
        let mut fixture = Fixture::new();
        let account = AccountIdentity {
            provider: "chesscom".into(),
            account: "player".into(),
        };
        let creation = refuse_account_activation(&fixture, &account).await;
        let published = created_source_bytes(&fixture, &creation);
        let cache_path = fixture
            .service
            .root
            .path()
            .join(format!("{}.db3", creation.id));
        // Keep the actual prepared cache object alive so startup cleanup cannot hide a new
        // cache generation by reusing the old native identity.
        let held_cache = File::open(&cache_path).unwrap();
        let old_identity = authority::opened_file_identity(&held_cache).unwrap();
        let produced_authority: serde_json::Value = serde_json::from_slice(
            &std::fs::read(fixture.directory.path().join("authority.json")).unwrap(),
        )
        .unwrap();
        let cache_locator =
            serde_json::to_value(authority::NativePath::from_path(&cache_path)).unwrap();
        let cache_entry = produced_authority["entries"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["path"] == cache_locator)
            .expect("interrupted creation did not durably publish private cache authority");
        assert_eq!(cache_entry["class"], "persistentFile");
        assert_eq!(cache_entry["purpose"], serde_json::Value::Null);
        assert_eq!(
            cache_entry["operations"],
            serde_json::json!(["databaseRead", "databaseExport"])
        );
        assert_eq!(
            cache_entry["identity"],
            serde_json::json!({"a":old_identity.0,"b":old_identity.1})
        );
        if cache_lost {
            std::fs::remove_file(&cache_path).unwrap();
            if replaced {
                File::create(&cache_path).unwrap().sync_all().unwrap();
            }
        }
        fixture.restart();
        let discovered = fixture.service.reconcile(
            &fixture.state.pgn_path_authority,
            &fixture.workspace,
            &CancellationToken::new(),
        );
        assert!(
            discovered.is_ok(),
            "CREATION_CACHE_DISCOVERY_REFUSED cacheLost={cache_lost} replaced={replaced}: {:?}",
            discovered.as_ref().err()
        );
        let discovered = discovered.unwrap();
        assert_eq!(discovered.len(), 1);
        assert_eq!(discovered[0].id, creation.id.to_string());
        assert_eq!(discovered[0].account.as_ref(), Some(&account));
        let app = fixture.app();
        let recovered = prepare_account_collection(
            fixture.workspace.clone(),
            account.clone(),
            None,
            app.state::<AppState>(),
        )
        .await;
        assert_eq!(created_source_bytes(&fixture, &creation), published);
        let current_identity =
            authority::opened_file_identity(&File::open(&cache_path).unwrap()).unwrap();
        assert!(recovered.is_ok(), "CREATION_CACHE_RECOVERY_REFUSED cacheLost={cache_lost}: {:?}\noldCacheIdentity={old_identity:?}\ncurrentCacheIdentity={current_identity:?}\nregistry={}\nauthority={}", recovered.as_ref().err().map(Error::diagnostic), std::fs::read_to_string(fixture.service.root.path().join(REGISTRY)).unwrap(), std::fs::read_to_string(fixture.directory.path().join("authority.json")).unwrap());
        let owner = recovered.unwrap().unwrap().collection.unwrap();
        assert_eq!(owner.id, creation.id.to_string());
        assert_eq!(owner.account.as_ref(), Some(&account));
        assert_eq!(owner.file, discovered[0].file);
        assert_eq!(
            serde_json::to_value(owner.database.as_ref().unwrap().path_ref()).unwrap(),
            cache_entry["id"]
        );
        assert!(fixture.rows(&owner).is_empty());
        assert_eq!(fixture.list().len(), 1);
        assert_eq!(
            std::fs::read_dir(fixture.directory.path().join("library"))
                .unwrap()
                .filter_map(Result::ok)
                .filter(|entry| entry
                    .path()
                    .extension()
                    .is_some_and(|extension| extension == "pgn"))
                .count(),
            1
        );
        if cache_lost {
            assert_ne!(
                old_identity, current_identity,
                "held deleted cache unexpectedly retained its native identity"
            );
        }
        fixture.restart();
        let app = fixture.app();
        let repeated = prepare_account_collection(
            fixture.workspace.clone(),
            account.clone(),
            None,
            app.state::<AppState>(),
        )
        .await
        .unwrap()
        .unwrap()
        .collection
        .unwrap();
        assert_eq!(repeated.id, owner.id);
        assert_eq!(repeated.file, owner.file);
        assert_eq!(repeated.database, owner.database);
        assert_eq!(created_source_bytes(&fixture, &creation), published);
        let input_body = game(Some("123"), "e4 e5", "after cache recovery");
        let input = fixture.create("recovered-input", &input_body, WorkspaceFileType::Other);
        let appended = Arc::clone(&fixture.service)
            .append_batch(
                fixture.state.pgn_path_authority.clone(),
                creation.id,
                input.clone(),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(appended.appended, 1);
        assert!(appended.committed && appended.index_ready);
        let after_append = created_source_bytes(&fixture, &creation);
        assert!(after_append.0.starts_with(&published.0));
        assert!(String::from_utf8_lossy(&after_append.0)
            .contains("https://www.chess.com/game/live/123"));
        assert_eq!(after_append.1, published.1);
        assert_eq!(fixture.rows(&fixture.list().pop().unwrap()).len(), 1);
        fixture.restart();
        let overlap = Arc::clone(&fixture.service)
            .append_batch(
                fixture.state.pgn_path_authority.clone(),
                creation.id,
                input,
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(overlap.appended, 0);
        let current = fixture.list();
        assert_eq!(current.len(), 1);
        assert_eq!(current[0].id, owner.id);
        assert_eq!(current[0].file, owner.file);
        assert_eq!(current[0].account, Some(account));
        assert_eq!(fixture.rows(&current[0]).len(), 1);
        assert_eq!(created_source_bytes(&fixture, &creation), after_append);
    }

    #[tokio::test]
    async fn account_creation_recovery_rebuilds_its_pre_activation_cache_after_restart() {
        assert_created_account_recovers_after_restart(false, false).await;
    }

    #[tokio::test]
    async fn account_creation_recovery_survives_deleted_pre_activation_cache() {
        assert_created_account_recovers_after_restart(true, false).await;
    }

    #[tokio::test]
    async fn account_creation_recovery_survives_replaced_pre_activation_cache() {
        assert_created_account_recovers_after_restart(true, true).await;
    }

    #[tokio::test]
    async fn account_preparation_recovers_distinct_unfinished_provider_owners_together() {
        use tauri::Manager;
        let mut fixture = Fixture::new();
        let first_account = AccountIdentity {
            provider: "chesscom".into(),
            account: "player".into(),
        };
        let second_account = AccountIdentity {
            provider: "lichess".into(),
            account: "player".into(),
        };
        let first = refuse_account_activation(&fixture, &first_account).await;
        let second = refuse_account_activation(&fixture, &second_account).await;
        assert_ne!(first.id, second.id);
        let first_bytes = created_source_bytes(&fixture, &first);
        let second_bytes = created_source_bytes(&fixture, &second);
        fixture.restart();
        let listed = fixture.list();
        assert_eq!(listed.len(), 2);
        for creation in [&first, &second] {
            let owner = listed
                .iter()
                .find(|record| record.id == creation.id.to_string())
                .unwrap();
            assert_eq!(owner.account.as_ref(), Some(&creation.account));
            assert_eq!(owner.status, CollectionStatus::Ready);
            let app = fixture.app();
            let prepared = prepare_account_collection(
                fixture.workspace.clone(),
                creation.account.clone(),
                None,
                app.state::<AppState>(),
            )
            .await
            .unwrap()
            .unwrap()
            .collection
            .unwrap();
            assert_eq!(prepared.id, owner.id);
            assert_eq!(prepared.file, owner.file);
        }
        fixture.restart();
        assert_eq!(fixture.list().len(), 2);
        assert_eq!(created_source_bytes(&fixture, &first), first_bytes);
        assert_eq!(created_source_bytes(&fixture, &second), second_bytes);
        assert!(CollectionService::state(
            &mut fixture.service.lock(&CancellationToken::new()).unwrap()
        )
        .unwrap()
        .creations
        .is_empty());
    }

    #[tokio::test]
    async fn account_preparation_refuses_invalid_identity_without_touching_owned_history() {
        use tauri::Manager;
        let fixture = Fixture::new();
        let account = AccountIdentity {
            provider: "chesscom".into(),
            account: "player".into(),
        };
        let app = fixture.app();
        let prepared = prepare_account_collection(
            fixture.workspace.clone(),
            account.clone(),
            None,
            app.state::<AppState>(),
        )
        .await
        .unwrap()
        .unwrap()
        .collection
        .unwrap();
        let id = Uuid::parse_str(&prepared.id).unwrap();
        let history = fixture.create(
            "history",
            &game(Some("123"), "e4 e5", "owned history"),
            WorkspaceFileType::Other,
        );
        Arc::clone(&fixture.service)
            .append_batch(
                fixture.state.pgn_path_authority.clone(),
                id,
                history,
                CancellationToken::new(),
            )
            .await
            .unwrap();
        let pending_body = game(Some("456"), "d4 d5", "retained pending history");
        let pending = fixture.create("pending", &pending_body, WorkspaceFileType::Other);
        let pending = fixture
            .service
            .stage_batch(
                &fixture.state.pgn_path_authority,
                id,
                pending,
                &CancellationToken::new(),
            )
            .unwrap();
        let record = fixture
            .service
            .record(id, &CancellationToken::new())
            .unwrap();
        let source_path = fixture
            .directory
            .path()
            .join("library")
            .join(&record.locator[0]);
        let pending_path = fixture
            .service
            .root
            .path()
            .join(format!("{}-batch.pgn", pending.id));
        let registry_path = fixture.service.root.path().join(REGISTRY);
        let source_bytes = std::fs::read(&source_path).unwrap();
        let pending_bytes = std::fs::read(&pending_path).unwrap();
        let registry_bytes = std::fs::read(&registry_path).unwrap();
        let invalid = [
            AccountIdentity {
                provider: "unknown".into(),
                ..account.clone()
            },
            AccountIdentity {
                account: String::new(),
                ..account.clone()
            },
            AccountIdentity {
                account: "x".repeat(65),
                ..account.clone()
            },
            AccountIdentity {
                account: "player/name".into(),
                ..account.clone()
            },
            AccountIdentity {
                account: "pläyer".into(),
                ..account.clone()
            },
        ];
        for invalid in invalid {
            let result = prepare_account_collection(
                fixture.workspace.clone(),
                invalid,
                None,
                app.state::<AppState>(),
            )
            .await;
            assert!(
                matches!(result, Err(Error::InvalidInput(_))),
                "invalid account admission touched an existing collection"
            );
            assert_eq!(std::fs::read(&registry_path).unwrap(), registry_bytes);
            assert_eq!(std::fs::read(&source_path).unwrap(), source_bytes);
            assert_eq!(std::fs::read(&pending_path).unwrap(), pending_bytes);
            assert_eq!(
                std::fs::read(fixture.path("pending")).unwrap(),
                pending_body.as_bytes()
            );
        }
        let other = AccountIdentity {
            provider: "lichess".into(),
            account: "Other-Player_2".into(),
        };
        let other = prepare_account_collection(
            fixture.workspace.clone(),
            other,
            None,
            app.state::<AppState>(),
        )
        .await
        .unwrap()
        .unwrap()
        .collection
        .unwrap();
        assert_eq!(other.account.unwrap().account, "other-player_2");
        assert_ne!(other.id, prepared.id);
        assert_ne!(other.file, prepared.file);
        assert_eq!(fixture.list().len(), 2);
        assert_eq!(std::fs::read(&source_path).unwrap(), source_bytes);
        assert_eq!(std::fs::read(&pending_path).unwrap(), pending_bytes);
    }

    #[tokio::test]
    async fn durable_registry_rejects_corrupted_produced_ownership_without_overwrite() {
        use tauri::Manager;
        let mut fixture = Fixture::new();
        let original = game(None, "d4 d5", "preserved original");
        let source = fixture.create("original", &original, WorkspaceFileType::Tournament);
        fixture.list();
        let history = game(None, "e4 e5", "chosen database history");
        let database = fixture.reference("history", &history);
        let intent = fixture.migration(database, Some(source), MigrationChoice::Database);
        let migration_id = intent.id;
        let chosen = fixture
            .service
            .migrate(
                &fixture.state.pgn_path_authority,
                &fixture.state.workspace_mutation,
                intent,
                &CancellationToken::new(),
            )
            .unwrap();
        let id = Uuid::parse_str(&chosen.id).unwrap();
        let known = fixture.create(
            "known",
            &game(Some("123"), "e4 e5", "known legacy identity"),
            WorkspaceFileType::Other,
        );
        let matched = Arc::clone(&fixture.service)
            .append_batch(
                fixture.state.pgn_path_authority.clone(),
                id,
                known,
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(matched.appended, 0);
        let pending = fixture.create(
            "pending",
            &game(Some("456"), "c4 c5", "retained pending batch"),
            WorkspaceFileType::Other,
        );
        let pending = fixture
            .service
            .stage_batch(
                &fixture.state.pgn_path_authority,
                id,
                pending,
                &CancellationToken::new(),
            )
            .unwrap();
        let registry_path = fixture.service.root.path().join(REGISTRY);
        let registry_bytes = std::fs::read(&registry_path).unwrap();
        let good = CollectionService::load(&fixture.service.root).unwrap();
        assert_eq!(good.records.len(), 2);
        assert!(good.records.iter().all(|record| record.database.is_some()));
        let record = fixture
            .service
            .record(id, &CancellationToken::new())
            .unwrap();
        let chosen_path = fixture
            .directory
            .path()
            .join("library")
            .join(&record.locator[0]);
        let paths = [
            fixture.path("original"),
            chosen_path.clone(),
            fixture.path("original").with_file_name(
                authority::workspace_sidecar_leaf(OsStr::new("original.pgn")).unwrap(),
            ),
            chosen_path
                .with_file_name(authority::workspace_sidecar_leaf(&record.locator[0]).unwrap()),
            fixture
                .service
                .root
                .path()
                .join(format!("{migration_id}-original.db3")),
            fixture
                .service
                .root
                .path()
                .join(format!("{migration_id}-original.pgn")),
            fixture
                .service
                .root
                .path()
                .join(format!("{id}-identity.db3")),
            fixture
                .service
                .root
                .path()
                .join(format!("{}-batch.pgn", pending.id)),
        ];
        let preserved: Vec<_> = paths
            .into_iter()
            .map(|path| {
                let bytes = std::fs::read(&path).unwrap();
                (path, bytes)
            })
            .collect();
        type Corruption = (&'static str, fn(&mut Registry));
        let cases: &[Corruption] = &[
            ("unsupported version", |registry| registry.version = 2),
            ("duplicate collection UUID", |registry| {
                registry.records[1].id = registry.records[0].id
            }),
            ("duplicate source binding", |registry| {
                registry.records[1].file = registry.records[0].file.clone()
            }),
            ("duplicate relative locator", |registry| {
                registry.records[1].locator = registry.records[0].locator.clone()
            }),
            ("empty relative locator", |registry| {
                registry.records[1].locator.clear()
            }),
            ("invalid locator component", |registry| {
                registry.records[1].locator.push(OsString::new())
            }),
            ("duplicate cache capability", |registry| {
                registry.records[1].database = registry.records[0].database.clone()
            }),
            ("noncanonical account", |registry| {
                registry
                    .records
                    .iter_mut()
                    .find_map(|record| record.account.as_mut())
                    .unwrap()
                    .account = "Player".into()
            }),
            ("duplicate account association", |registry| {
                registry.records[0].account = registry.records[1].account.clone()
            }),
            ("duplicate migration UUID", |registry| {
                registry.migrations.push(registry.migrations[0].clone())
            }),
            ("noncanonical migration account", |registry| {
                registry.migrations[0].account.as_mut().unwrap().account = "Player".into()
            }),
            ("missing chosen identity", |registry| {
                registry.migrations[0].collection = Some(Uuid::new_v4())
            }),
            ("missing original identity", |registry| {
                registry.migrations[0].original_collection = Some(Uuid::new_v4())
            }),
            ("chosen identity as original", |registry| {
                registry.migrations[0].original_collection = registry.migrations[0].collection
            }),
        ];
        for (label, corrupt) in cases {
            let mut corrupted = good.clone();
            corrupt(&mut corrupted);
            let bytes = serde_json::to_vec(&corrupted).unwrap();
            std::fs::write(&registry_path, &bytes).unwrap();
            assert!(
                CollectionService::load(&fixture.service.root).is_err(),
                "source-derived registry admitted {label}"
            );
            fixture.restart();
            let app = fixture.app();
            let result = prepare_account_collection(
                fixture.workspace.clone(),
                record.account.clone().unwrap(),
                None,
                app.state::<AppState>(),
            )
            .await;
            assert!(
                matches!(result, Err(Error::Conflict(_))),
                "public preparation accepted corrupt ownership: {label}"
            );
            assert_eq!(
                std::fs::read(&registry_path).unwrap(),
                bytes,
                "corrupt registry was overwritten: {label}"
            );
            for (path, before) in &preserved {
                assert_eq!(
                    &std::fs::read(path).unwrap(),
                    before,
                    "preserved native data changed for {label}: {}",
                    path.display()
                );
            }
            drop(app);
            std::fs::write(&registry_path, &registry_bytes).unwrap();
            fixture.restart();
            let listed = fixture.list();
            assert_eq!(
                listed
                    .iter()
                    .filter(|record| record.status == CollectionStatus::Ready)
                    .count(),
                1
            );
            assert_eq!(
                listed
                    .iter()
                    .filter(|record| record.status == CollectionStatus::PreservedOriginal)
                    .count(),
                1
            );
            let app = fixture.app();
            let recovered = prepare_account_collection(
                fixture.workspace.clone(),
                record.account.clone().unwrap(),
                None,
                app.state::<AppState>(),
            )
            .await
            .unwrap()
            .unwrap();
            assert_eq!(recovered.collection.unwrap().id, chosen.id);
            assert_eq!(recovered.pending_batch, pending.owned_source);
        }
    }

    #[tokio::test]
    async fn unsupported_identity_evidence_refuses_append_and_preserves_native_input() {
        let fixture = Fixture::new();
        let original = game(None, "e4 e5", "legacy evidence owner");
        fixture.create("source", &original, WorkspaceFileType::Game);
        let collection = fixture.list().pop().unwrap();
        fixture.account(&collection.id, "chesscom");
        let id = Uuid::parse_str(&collection.id).unwrap();
        let known = fixture.create(
            "known",
            &game(Some("123"), "e4 e5", "known legacy identity"),
            WorkspaceFileType::Other,
        );
        let matched = Arc::clone(&fixture.service)
            .append_batch(
                fixture.state.pgn_path_authority.clone(),
                id,
                known,
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(matched.appended, 0);
        let body = game(Some("456"), "d4 d5", "independent incoming game");
        let incoming = fixture.create("incoming", &body, WorkspaceFileType::Other);
        let pending = fixture
            .service
            .stage_batch(
                &fixture.state.pgn_path_authority,
                id,
                incoming.clone(),
                &CancellationToken::new(),
            )
            .unwrap();
        let record = fixture
            .service
            .record(id, &CancellationToken::new())
            .unwrap();
        let evidence = legacy::open(&fixture.service, &record).unwrap();
        assert_eq!(
            evidence
                .query_row("SELECT count(*) FROM Evidence WHERE ID='123'", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            1
        );
        evidence.pragma_update(None, "user_version", 2).unwrap();
        let evidence_path = fixture
            .service
            .root
            .path()
            .join(format!("{id}-identity.db3"));
        let evidence_bytes = std::fs::read(&evidence_path).unwrap();
        let pending_path = fixture
            .service
            .root
            .path()
            .join(format!("{}-batch.pgn", pending.id));
        let pending_bytes = std::fs::read(&pending_path).unwrap();
        let refused = Arc::clone(&fixture.service)
            .append_batch(
                fixture.state.pgn_path_authority.clone(),
                id,
                incoming.clone(),
                CancellationToken::new(),
            )
            .await;
        assert!(
            matches!(&refused, Err(Error::Conflict(message)) if message == "unsupported collection identity evidence"),
            "unsupported identity evidence was accepted for append"
        );
        assert_eq!(
            std::fs::read(fixture.path("source")).unwrap(),
            original.as_bytes()
        );
        assert_eq!(
            std::fs::read(fixture.path("incoming")).unwrap(),
            body.as_bytes()
        );
        assert_eq!(std::fs::read(&pending_path).unwrap(), pending_bytes);
        assert_eq!(std::fs::read(&evidence_path).unwrap(), evidence_bytes);
        assert_eq!(
            fixture
                .service
                .record(id, &CancellationToken::new())
                .unwrap()
                .pending
                .unwrap()
                .id,
            pending.id
        );
        evidence.pragma_update(None, "user_version", 1).unwrap();
        drop(evidence);
        let retry = Arc::clone(&fixture.service)
            .append_batch(
                fixture.state.pgn_path_authority.clone(),
                id,
                incoming,
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(retry.appended, 1);
        assert!(std::fs::read(fixture.path("source"))
            .unwrap()
            .starts_with(original.as_bytes()));
        let record = fixture
            .service
            .record(id, &CancellationToken::new())
            .unwrap();
        let evidence = legacy::open(&fixture.service, &record).unwrap();
        assert_eq!(
            evidence
                .query_row("SELECT count(*) FROM Evidence WHERE ID='123'", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            1
        );
    }

    #[tokio::test]
    async fn declined_account_offer_survives_restart_and_explicit_link_remains_available() {
        use tauri::Manager;
        let mut fixture = Fixture::new();
        let body = game(Some("123"), "e4 e5", "accumulated history");
        let database = fixture.reference("legacy-account", &body);
        let account = AccountIdentity {
            provider: "chesscom".into(),
            account: "player".into(),
        };
        let app = fixture.app();
        let database_path = fixture.directory.path().join("legacy-account.db3");
        let prior_database = std::fs::read(&database_path).unwrap();
        let prior_files: std::collections::BTreeSet<_> =
            std::fs::read_dir(fixture.directory.path().join("library"))
                .unwrap()
                .map(|entry| entry.unwrap().file_name())
                .collect();
        let required = prepare_account_collection(
            fixture.workspace.clone(),
            account.clone(),
            Some(database.clone()),
            app.state::<AppState>(),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(required.migration_required);
        assert!(required.collection.is_none());
        assert!(required.pending_batch.is_none());
        assert!(
            fixture.list().is_empty(),
            "legacy preparation created an empty replacement collection"
        );
        let after_files: std::collections::BTreeSet<_> =
            std::fs::read_dir(fixture.directory.path().join("library"))
                .unwrap()
                .map(|entry| entry.unwrap().file_name())
                .collect();
        assert_eq!(
            after_files, prior_files,
            "legacy preparation created a replacement PGN"
        );
        assert_eq!(std::fs::read(&database_path).unwrap(), prior_database);
        assert!(migrate_linked_collection(
            Uuid::new_v4().to_string(),
            fixture.workspace.clone(),
            database.clone(),
            None,
            MigrationChoice::Decline,
            Some(account.clone()),
            "history".into(),
            app.state::<AppState>()
        )
        .await
        .unwrap()
        .is_none());
        drop(app);
        fixture.restart();
        let app = fixture.app();
        assert!(
            prepare_account_collection(
                fixture.workspace.clone(),
                account.clone(),
                Some(database.clone()),
                app.state::<AppState>()
            )
            .await
            .unwrap()
            .is_none(),
            "a remembered decline was offered again"
        );
        assert!(fixture.list().is_empty());
        assert_eq!(std::fs::read(&database_path).unwrap(), prior_database);
        let linked = migrate_linked_collection(
            Uuid::new_v4().to_string(),
            fixture.workspace.clone(),
            database,
            None,
            MigrationChoice::Database,
            Some(account),
            "history".into(),
            app.state::<AppState>(),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(fixture.rows(&linked).len(), 1);
        assert_eq!(fixture.list().len(), 1);
    }

    #[test]
    fn metadata_checks_never_rebuild_and_a_lost_disposable_cache_keeps_its_capability() {
        let mut fixture = Fixture::new();
        let original = game(Some("123"), "e4 e5", "original");
        fixture.create("source", &original, WorkspaceFileType::Game);
        let collection = fixture.list().pop().unwrap();
        let database = collection.database.clone().unwrap();
        let old_query: GameQuery = serde_json::from_value(serde_json::json!({"position":{"fen":"rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1","type_":"exact"}})).unwrap();
        assert_eq!(
            super::super::search::run_position_search(
                fixture.app().handle(),
                &database,
                old_query,
                "before-cache-loss"
            )
            .unwrap()
            .1
            .len(),
            1
        );
        let changed = game(Some("456"), "d4 d5", "external");
        std::fs::write(fixture.path("source"), &changed).unwrap();
        *fixture.service.rebuild_hook.lock().unwrap() = Some(Box::new(|| {
            Err(Error::Conflict("index storage refused".into()))
        }));
        let metadata = fixture
            .service
            .metadata_for_database(
                &fixture.state.pgn_path_authority,
                &database,
                &CancellationToken::new(),
            )
            .unwrap()
            .unwrap();
        assert!(matches!(metadata.status, CollectionStatus::Stale));
        assert_ne!(metadata.generation, collection.generation);
        assert!(get_games_blocking(
            &fixture.state.pgn_path_authority,
            &fixture.state.database_repository,
            database.clone(),
            GameQuery::new(),
            &CancellationToken::new()
        )
        .is_err());
        fixture.restart();
        let path = fixture
            .directory
            .path()
            .join("app/collections")
            .join(format!("{}.db3", collection.id));
        for suffix in ["", "-wal", "-shm"] {
            let path = PathBuf::from(format!("{}{suffix}", path.display()));
            if path.exists() {
                std::fs::remove_file(path).unwrap();
            }
        }
        let rows = get_games_blocking(
            &fixture.state.pgn_path_authority,
            &fixture.state.database_repository,
            database.clone(),
            GameQuery::new(),
            &CancellationToken::new(),
        )
        .unwrap();
        assert_eq!(rows.data.len(), 1);
        assert!(rows.data[0].moves.contains("d4"));
        let current = fixture.list().pop().unwrap();
        assert_eq!(current.database, Some(database.clone()));
        assert_eq!(current.id, collection.id);
        let query: GameQuery = serde_json::from_value(serde_json::json!({"position":{"fen":"rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq d3 0 1","type_":"exact"}})).unwrap();
        let searched = super::super::search::run_position_search(
            fixture.app().handle(),
            &database,
            query,
            "after-cache-loss",
        )
        .unwrap();
        assert_eq!(searched.1.len(), 1);
        assert_eq!(searched.0[0].move_, "d5");
        assert_eq!(
            searched.1[0].linked.as_ref().unwrap().generation,
            current.generation
        );
        assert!(
            matches!(
                fixture.service.resolve_game(
                    &fixture.state.pgn_path_authority,
                    &database,
                    rows.data[0].id,
                    None,
                    &CancellationToken::new()
                ),
                Err(Error::StaleGame)
            ),
            "a cache row without its admitted generation was opened"
        );
        assert_eq!(
            std::fs::read(fixture.path("source")).unwrap(),
            changed.as_bytes()
        );
    }

    #[tokio::test]
    async fn a_failed_migration_can_be_declined_without_overwriting_its_recovery_artifacts() {
        use tauri::Manager;
        let mut fixture = Fixture::new();
        let original = game(Some("456"), "d4 d5", "original file edits");
        let source = fixture.create("selected", &original, WorkspaceFileType::Other);
        let database =
            fixture.reference("legacy", &game(Some("123"), "e4 e5", "original database"));
        let request = Uuid::new_v4();
        let occupied = fixture
            .service
            .root
            .path()
            .join(format!("{request}-original.db3"));
        std::fs::write(&occupied, b"an existing recovery artifact must survive").unwrap();
        let app = fixture.app();
        assert!(migrate_linked_collection(
            request.to_string(),
            fixture.workspace.clone(),
            database.clone(),
            Some(source.clone()),
            MigrationChoice::Database,
            None,
            "history".into(),
            app.state::<AppState>()
        )
        .await
        .is_err());
        assert!(migrate_linked_collection(
            request.to_string(),
            fixture.workspace.clone(),
            database.clone(),
            Some(source.clone()),
            MigrationChoice::Decline,
            None,
            "history".into(),
            app.state::<AppState>()
        )
        .await
        .unwrap()
        .is_none());
        let rows = get_games_blocking(
            &fixture.state.pgn_path_authority,
            &fixture.state.database_repository,
            database.clone(),
            GameQuery::new(),
            &CancellationToken::new(),
        )
        .unwrap();
        write_db_game(
            database.clone(),
            rows.data[0].id,
            game(Some("123"), "c4 c5", "database remains editable"),
            app.state::<AppState>(),
        )
        .await
        .unwrap();
        drop(app);
        fixture.restart();
        assert!(fixture.list().is_empty());
        let app = fixture.app();
        let linked = migrate_linked_collection(
            Uuid::new_v4().to_string(),
            fixture.workspace.clone(),
            database,
            Some(source),
            MigrationChoice::Database,
            None,
            "history".into(),
            app.state::<AppState>(),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(fixture.rows(&linked).len(), 1);
        assert!(fixture.rows(&linked)[0].moves.contains("c4"));
        assert_eq!(
            std::fs::read(fixture.path("selected")).unwrap(),
            original.as_bytes()
        );
        assert_eq!(
            std::fs::read(occupied).unwrap(),
            b"an existing recovery artifact must survive"
        );
    }

    #[tokio::test]
    async fn concurrent_migration_commands_publish_one_collection_and_one_new_source() {
        use tauri::Manager;
        let fixture = Fixture::new();
        let database =
            fixture.reference("legacy", &game(Some("123"), "e4 e5", "accumulated history"));
        std::fs::remove_file(fixture.path("import-legacy")).unwrap();
        let app = fixture.app();
        let (first, second) = tokio::join!(
            migrate_linked_collection(
                Uuid::new_v4().to_string(),
                fixture.workspace.clone(),
                database.clone(),
                None,
                MigrationChoice::Database,
                None,
                "history".into(),
                app.state::<AppState>()
            ),
            migrate_linked_collection(
                Uuid::new_v4().to_string(),
                fixture.workspace.clone(),
                database,
                None,
                MigrationChoice::Database,
                None,
                "history".into(),
                app.state::<AppState>()
            )
        );
        assert_eq!(first.unwrap().unwrap().id, second.unwrap().unwrap().id);
        assert_eq!(fixture.list().len(), 1);
        assert_eq!(
            std::fs::read_dir(fixture.directory.path().join("library"))
                .unwrap()
                .filter(|entry| entry
                    .as_ref()
                    .unwrap()
                    .path()
                    .extension()
                    .is_some_and(|extension| extension == "pgn"))
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn incomplete_legacy_identity_stays_searchable_and_refuses_ambiguous_account_append() {
        let fixture = Fixture::new();
        let original =
            game(Some("123"), "e4 e5", "legacy history").replace("[UTCTime \"12:00:00\"]\n", "");
        let database = fixture.reference("legacy-identity", &original);
        std::fs::remove_file(fixture.path("import-legacy-identity")).unwrap();
        let intent = fixture.migration(database, None, MigrationChoice::Database);
        let collection = fixture
            .service
            .migrate(
                &fixture.state.pgn_path_authority,
                &fixture.state.workspace_mutation,
                intent,
                &CancellationToken::new(),
            )
            .unwrap();
        assert!(matches!(collection.status, CollectionStatus::Ready), "valid legacy games became unsearchable because account identity fields were incomplete");
        assert_eq!(fixture.rows(&collection).len(), 1);
        let before = std::fs::read(fixture.path("migrated")).unwrap();
        let body = game(Some("123"), "e4 e5", "new provider body");
        let input = fixture.create("incoming", &body, WorkspaceFileType::Other);
        assert!(matches!(
            Arc::clone(&fixture.service)
                .append_batch(
                    fixture.state.pgn_path_authority.clone(),
                    Uuid::parse_str(&collection.id).unwrap(),
                    input,
                    CancellationToken::new()
                )
                .await,
            Err(Error::Conflict(_))
        ));
        assert_eq!(std::fs::read(fixture.path("migrated")).unwrap(), before);
        assert_eq!(
            std::fs::read(fixture.path("incoming")).unwrap(),
            body.as_bytes()
        );
    }

    #[test]
    fn native_relative_locator_preserves_non_unicode_filename_bytes_across_restart() {
        use std::os::unix::ffi::OsStringExt;
        let mut fixture = Fixture::new();
        let body = game(None, "e4 e5", "untouched");
        let filename = OsString::from_vec(b"games-\xff.pgn".to_vec());
        let path = fixture.directory.path().join("library").join(&filename);
        let creation = std::fs::write(&path, &body);
        #[cfg(target_os = "macos")]
        if creation
            .as_ref()
            .is_err_and(|error| error.raw_os_error() == Some(libc::EILSEQ))
        {
            return;
        }
        creation.unwrap();
        let file = FileWorkspaceHandle::new(
            fixture
                .state
                .pgn_path_authority
                .with_mut(|authority| {
                    authority.get_or_create_persistent_file(
                        &path,
                        "Native source",
                        vec![PathOperation::ReadPgn, PathOperation::WritePgn],
                    )
                })
                .unwrap()
                .unwrap()
                .id,
        );
        let snapshot = fixture
            .state
            .pgn_path_authority
            .with_mut(|authority| {
                authority
                    .resolve(file.path_ref(), PathOperation::ReadPgn, &[])?
                    .pgn_snapshot()
            })
            .unwrap()
            .unwrap();
        let id = Uuid::new_v4();
        let mut record = Record {
            id,
            workspace: fixture.workspace.clone(),
            locator: vec![filename.clone()],
            trash_locator: vec![],
            file,
            identity: snapshot.identity.pair(),
            source_epoch: 0,
            purpose: WorkspaceFileType::Game,
            account: None,
            database: None,
            retired_database: None,
            pending: None,
            coverage_cursor_ms: None,
        };
        fixture
            .service
            .ensure_cache(&fixture.state.pgn_path_authority, &mut record)
            .unwrap();
        let mut guard = fixture.service.lock(&CancellationToken::new()).unwrap();
        let mut registry = CollectionService::state(&mut guard).unwrap().clone();
        registry.records.push(record.clone());
        fixture.service.save(&mut guard, registry).unwrap();
        drop(guard);
        fixture
            .service
            .refresh(
                &fixture.state.pgn_path_authority,
                id,
                &CancellationToken::new(),
            )
            .unwrap();
        fixture.restart();
        let restored = fixture
            .service
            .record(id, &CancellationToken::new())
            .unwrap();
        assert_eq!(restored.locator, vec![filename]);
        assert_eq!(
            fixture
                .rows(
                    &fixture
                        .service
                        .describe(
                            &fixture.state.pgn_path_authority,
                            &restored,
                            &CancellationToken::new()
                        )
                        .unwrap()
                )
                .len(),
            1
        );
        assert_eq!(std::fs::read(path).unwrap(), body.as_bytes());
    }

    #[test]
    fn three_hundred_megabyte_collection_rebuild_streams_bounded_game_bodies() {
        let fixture = Fixture::new();
        fixture.create("large", "", WorkspaceFileType::Game);
        let block = format!("{}\n", "x".repeat(1023)).repeat(1024);
        let body = game(None, "e4 e5", &block);
        let mut file = std::io::BufWriter::new(
            File::options()
                .write(true)
                .open(fixture.path("large"))
                .unwrap(),
        );
        for _ in 0..300 {
            file.write_all(body.as_bytes()).unwrap();
        }
        file.flush().unwrap();
        drop(file);
        assert!(std::fs::metadata(fixture.path("large")).unwrap().len() >= 300 * 1024 * 1024);
        let (collections, peak) = super::super::allocation_probe::measure(|| fixture.list());
        assert!(
            peak < 64 * 1024 * 1024,
            "collection rebuild retained {peak} Rust heap bytes"
        );
        assert_eq!(fixture.rows(&collections[0]).len(), 300);
        println!("linked_collections 300 MB rebuild peak synchronous Rust heap: {peak} bytes, excluding SQLite allocations and mmap pages");
    }

    #[tokio::test]
    async fn verification_artifacts_use_real_migration_append_export_and_restore() {
        use tauri::Manager;
        let fixture = Fixture::new();
        let original = game(Some("123"), "e4 (1. d4 d5) $1 e5", "original note");
        let source = fixture.create("source", &original, WorkspaceFileType::Other);
        let database = fixture.reference(
            "original-reference",
            &game(Some("789"), "c4 c5", "database version"),
        );
        let intent = fixture.migration(database, Some(source), MigrationChoice::Pgn);
        let collection = fixture
            .service
            .migrate(
                &fixture.state.pgn_path_authority,
                &fixture.state.workspace_mutation,
                intent,
                &CancellationToken::new(),
            )
            .unwrap();
        let batch = fixture.create(
            "incoming",
            &format!(
                "{}{}",
                game(Some("123"), "e4 e5", "download"),
                game(Some("456"), "d4 d5", "new game")
            ),
            WorkspaceFileType::Other,
        );
        let outcome = Arc::clone(&fixture.service)
            .append_batch(
                fixture.state.pgn_path_authority.clone(),
                Uuid::parse_str(&collection.id).unwrap(),
                batch,
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(outcome.appended, 1);
        assert!(outcome.index_ready);
        let current = fixture.list().pop().unwrap();
        edit_linked_collection(
            current.id,
            current.generation,
            CollectionEdit::RenamePlayer {
                from: "Player".into(),
                to: "Edited Player".into(),
            },
            fixture.app().state::<AppState>(),
        )
        .await
        .unwrap();
        let exported = fixture.create("exported", "", WorkspaceFileType::Other);
        export_to_pgn_blocking(
            &fixture.state.pgn_path_authority,
            &fixture.state.database_repository,
            collection.database.clone().unwrap(),
            exported,
            &CancellationToken::new(),
        )
        .unwrap();
        let restored_path = fixture.directory.path().join("restored.db3");
        File::create(&restored_path).unwrap();
        let restored = DatabaseHandle::new(
            fixture
                .state
                .pgn_path_authority
                .with_mut(|authority| {
                    authority.get_or_create_persistent_file(
                        &restored_path,
                        "restored",
                        vec![
                            PathOperation::DatabaseCreate,
                            PathOperation::DatabaseRead,
                            PathOperation::DatabaseExport,
                        ],
                    )
                })
                .unwrap()
                .unwrap()
                .id,
        );
        fixture
            .service
            .restore_archive(
                &fixture.state.pgn_path_authority,
                Uuid::parse_str(&collection.id).unwrap(),
                &restored,
                &CancellationToken::new(),
            )
            .unwrap();
        let archive_export = fixture.create("restored-export", "", WorkspaceFileType::Other);
        export_to_pgn_blocking(
            &fixture.state.pgn_path_authority,
            &fixture.state.database_repository,
            restored,
            archive_export,
            &CancellationToken::new(),
        )
        .unwrap();
        assert_eq!(
            std::fs::read(fixture.path("source")).unwrap(),
            std::fs::read(fixture.path("exported")).unwrap()
        );
        assert_eq!(fixture.rows(&fixture.list().pop().unwrap()).len(), 2);
        if std::env::var_os("CHESSFABLE_LINKED_ARTIFACTS").is_some() {
            let query: GameQuery = serde_json::from_value(serde_json::json!({"position":{"fen":"rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq d3 0 1","type_":"exact"}})).unwrap();
            let search = super::super::search::run_position_search(
                fixture.app().handle(),
                collection.database.as_ref().unwrap(),
                query,
                "artifact-search",
            )
            .unwrap();
            let search_path = fixture.directory.path().join("search.json");
            std::fs::write(&search_path, serde_json::to_vec(&search).unwrap()).unwrap();
            let artifacts = serde_json::json!({"source":fixture.path("source"),"exported":fixture.path("exported"),"archived":fixture.path("restored-export"),"cache":fixture.service.root.path().join(format!("{}.db3",collection.id)),"search":search_path});
            println!("linked-collection-artifacts {artifacts}");
            let retained = fixture.directory.keep();
            println!(
                "linked-collection-artifact-directory {}",
                retained.display()
            );
        }
    }

    #[tokio::test]
    async fn interrupted_library_append_recognizes_published_bytes_after_restart_without_provider_ids(
    ) {
        let mut fixture = Fixture::new();
        let original = game(None, "e4 e5", "user data");
        fixture.create("source", &original, WorkspaceFileType::Game);
        let collection = fixture.list().pop().unwrap();
        let id = Uuid::parse_str(&collection.id).unwrap();
        let incoming = fixture.create(
            "incoming",
            &game(None, "d4 d5", "new occurrence"),
            WorkspaceFileType::Other,
        );
        *fixture.service.rebuild_hook.lock().unwrap() = Some(Box::new(|| {
            Err(Error::ResourceLimit(
                "index storage unavailable after publication".into(),
            ))
        }));
        let outcome = Arc::clone(&fixture.service)
            .append_batch(
                fixture.state.pgn_path_authority.clone(),
                id,
                incoming,
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert!(
            outcome.committed && !outcome.index_ready && !outcome.durability_confirmed,
            "a post-publication failure was reported as no append"
        );
        let bytes = std::fs::read(fixture.path("source")).unwrap();
        assert_eq!(
            String::from_utf8_lossy(&bytes).matches("[Event ").count(),
            2
        );
        fixture.restart();
        let pending = fixture
            .service
            .pending_source(
                &fixture.state.pgn_path_authority,
                id,
                &CancellationToken::new(),
            )
            .unwrap()
            .unwrap();
        let outcome = Arc::clone(&fixture.service)
            .append_batch(
                fixture.state.pgn_path_authority.clone(),
                id,
                pending,
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert!(outcome.committed && outcome.index_ready);
        assert_eq!(
            outcome.appended, 0,
            "uncertain non-provider batch was appended twice"
        );
        assert_eq!(std::fs::read(fixture.path("source")).unwrap(), bytes);
        assert_eq!(fixture.rows(&fixture.list().pop().unwrap()).len(), 2);
        assert!(fixture
            .service
            .pending_source(
                &fixture.state.pgn_path_authority,
                id,
                &CancellationToken::new()
            )
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn append_cancellation_and_external_commit_race_preserve_input_and_retry_from_current_source(
    ) {
        use std::time::Duration;
        let fixture = Fixture::new();
        let original = game(Some("123"), "e4 e5", "original");
        fixture.create("source", &original, WorkspaceFileType::Game);
        let collection = fixture.list().pop().unwrap();
        let id = Uuid::parse_str(&collection.id).unwrap();
        fixture.account(&collection.id, "chesscom");
        let incoming = fixture.create(
            "incoming",
            &game(Some("456"), "d4 d5", "new"),
            WorkspaceFileType::Other,
        );
        let cancelled = CancellationToken::new();
        cancelled.cancel();
        assert!(matches!(
            Arc::clone(&fixture.service)
                .append_batch(
                    fixture.state.pgn_path_authority.clone(),
                    id,
                    incoming.clone(),
                    cancelled
                )
                .await,
            Err(Error::Cancellation)
        ));
        assert_eq!(
            std::fs::read(fixture.path("source")).unwrap(),
            original.as_bytes()
        );
        let (hook, entered, release) = pgn::BoundedHook::new();
        fixture
            .state
            .pgn_repository
            .set_edit_worker_hook(Some(hook))
            .unwrap();
        let task = tokio::spawn(Arc::clone(&fixture.service).append_batch(
            fixture.state.pgn_path_authority.clone(),
            id,
            incoming,
            CancellationToken::new(),
        ));
        tokio::time::timeout(Duration::from_secs(10), entered)
            .await
            .unwrap()
            .unwrap();
        let different = fixture.create(
            "concurrent-input",
            &game(Some("999"), "Nf3 Nf6", "a different Library input"),
            WorkspaceFileType::Other,
        );
        assert!(
            matches!(
                Arc::clone(&fixture.service)
                    .append_batch(
                        fixture.state.pgn_path_authority.clone(),
                        id,
                        different,
                        CancellationToken::new()
                    )
                    .await,
                Err(Error::Conflict(_))
            ),
            "a concurrent append silently adopted the first caller's batch"
        );
        assert!(std::fs::read_to_string(fixture.path("concurrent-input"))
            .unwrap()
            .contains("/999\""));
        let external = game(Some("789"), "c4 c5", "external user rewrite");
        std::fs::write(fixture.path("source"), &external).unwrap();
        release.send(()).unwrap();
        assert!(
            task.await.unwrap().is_err(),
            "an append overwrote a source changed after preparation"
        );
        assert_eq!(
            std::fs::read(fixture.path("source")).unwrap(),
            external.as_bytes()
        );
        let batch = fixture
            .service
            .pending_source(
                &fixture.state.pgn_path_authority,
                id,
                &CancellationToken::new(),
            )
            .unwrap()
            .unwrap();
        let retry = Arc::clone(&fixture.service)
            .append_batch(
                fixture.state.pgn_path_authority.clone(),
                id,
                batch,
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(retry.appended, 1);
        assert!(std::fs::read(fixture.path("source"))
            .unwrap()
            .starts_with(external.as_bytes()));
    }

    #[tokio::test]
    async fn a_completed_append_retries_cleanup_after_its_owned_batch_has_already_been_removed() {
        let fixture = Fixture::new();
        fixture.create(
            "source",
            &game(None, "e4 e5", "original"),
            WorkspaceFileType::Game,
        );
        let collection = fixture.list().pop().unwrap();
        let id = Uuid::parse_str(&collection.id).unwrap();
        let input = fixture.create(
            "incoming",
            &game(None, "d4 d5", "new"),
            WorkspaceFileType::Other,
        );
        *fixture.service.rebuild_hook.lock().unwrap() = Some(Box::new(|| {
            Err(Error::ResourceLimit("index completion refused".into()))
        }));
        let outcome = Arc::clone(&fixture.service)
            .append_batch(
                fixture.state.pgn_path_authority.clone(),
                id,
                input.clone(),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert!(outcome.committed && !outcome.index_ready);
        let before = std::fs::read(fixture.path("source")).unwrap();
        *fixture.service.rebuild_hook.lock().unwrap() = None;
        fixture
            .service
            .refresh(
                &fixture.state.pgn_path_authority,
                id,
                &CancellationToken::new(),
            )
            .unwrap();
        let pending = fixture
            .service
            .record(id, &CancellationToken::new())
            .unwrap()
            .pending
            .unwrap();
        let leaf = fixture
            .service
            .root
            .path()
            .join(format!("{}-batch.pgn", pending.id));
        let fault = fs::scoped_test_removal_injector(Arc::new(fs::RemovalFault(
            fs::RemovalFaultPoint::ParentSync,
        )));
        assert!(fixture
            .service
            .finish_pending(
                &fixture.state.pgn_path_authority,
                id,
                pending,
                &CancellationToken::new()
            )
            .is_err());
        drop(fault);
        assert!(!leaf.exists());
        let retried = Arc::clone(&fixture.service)
            .append_batch(
                fixture.state.pgn_path_authority.clone(),
                id,
                input,
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert!(retried.committed && retried.index_ready);
        assert_eq!(
            retried.appended, 0,
            "cleanup retry appended an already committed non-provider batch"
        );
        assert_eq!(std::fs::read(fixture.path("source")).unwrap(), before);
        assert!(fixture
            .service
            .record(id, &CancellationToken::new())
            .unwrap()
            .pending
            .is_none());
    }

    #[tokio::test]
    async fn library_pending_input_remains_recoverable_after_the_original_input_changes_and_restart(
    ) {
        let mut fixture = Fixture::new();
        fixture.create(
            "source",
            &game(None, "e4 e5", "original"),
            WorkspaceFileType::Game,
        );
        let collection = fixture.list().pop().unwrap();
        let id = Uuid::parse_str(&collection.id).unwrap();
        let old_body = game(None, "d4 d5", "preserved old input");
        let input = fixture.create("incoming", &old_body, WorkspaceFileType::Other);
        fixture
            .service
            .stage_batch(
                &fixture.state.pgn_path_authority,
                id,
                input.clone(),
                &CancellationToken::new(),
            )
            .unwrap();
        let new_body = game(None, "c4 c5", "newly selected input");
        std::fs::write(fixture.path("incoming"), &new_body).unwrap();
        assert!(matches!(
            Arc::clone(&fixture.service)
                .append_batch(
                    fixture.state.pgn_path_authority.clone(),
                    id,
                    input.clone(),
                    CancellationToken::new()
                )
                .await,
            Err(Error::Conflict(_))
        ));
        fixture.restart();
        let current = fixture.list().pop().unwrap();
        let owned = current.pending_batch.unwrap();
        assert_ne!(owned, input);
        let grant_is_recorded = || {
            let registry: serde_json::Value = serde_json::from_reader(
                File::open(fixture.directory.path().join("authority.json")).unwrap(),
            )
            .unwrap();
            registry["entries"]
                .as_array()
                .unwrap()
                .iter()
                .any(|entry| entry["id"]["id"] == owned.path_ref().id)
        };
        assert!(
            grant_is_recorded(),
            "pending batch has no durable read grant"
        );
        assert!(fixture
            .state
            .pgn_path_authority
            .with_mut(|authority| authority.display_name(owned.path_ref()))
            .unwrap()
            .is_ok());
        let result = Arc::clone(&fixture.service)
            .append_batch(
                fixture.state.pgn_path_authority.clone(),
                id,
                owned.clone(),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(result.appended, 1);
        assert!(
            !grant_is_recorded(),
            "completed batch retained its durable authority grant"
        );
        assert!(
            fixture
                .state
                .pgn_path_authority
                .with_mut(|authority| authority.display_name(owned.path_ref()))
                .unwrap()
                .is_err(),
            "completed batch retained its transient authority grant"
        );
        let source = std::fs::read_to_string(fixture.path("source")).unwrap();
        assert!(source.contains("1. d4 d5") && !source.contains("1. c4 c5"));
        assert_eq!(
            std::fs::read(fixture.path("incoming")).unwrap(),
            new_body.as_bytes()
        );
        let result = Arc::clone(&fixture.service)
            .append_batch(
                fixture.state.pgn_path_authority.clone(),
                id,
                input,
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(result.appended, 1);
        assert_eq!(fixture.rows(&fixture.list().pop().unwrap()).len(), 3);
    }

    #[tokio::test]
    async fn purpose_retirement_and_library_trash_restore_keep_the_source_and_collection_identity()
    {
        use tauri::Manager;
        let fixture = Fixture::new();
        let body = game(None, "e4 e5", "custom data");
        let file = fixture.create("source", &body, WorkspaceFileType::Game);
        let collection = fixture.list().pop().unwrap();
        let app = fixture.app();
        let id = Uuid::parse_str(&collection.id).unwrap();
        crate::file_workspace::write_workspace_file_metadata(
            fixture.workspace.clone(),
            file.clone(),
            WorkspaceMetadata {
                file_type: WorkspaceFileType::Other,
                tags: vec!["kept".into()],
            },
            app.state::<AppState>(),
        )
        .await
        .unwrap();
        let retired = fixture
            .service
            .metadata_for_database(
                &fixture.state.pgn_path_authority,
                collection.database.as_ref().unwrap(),
                &CancellationToken::new(),
            )
            .unwrap()
            .unwrap();
        assert!(matches!(retired.status, CollectionStatus::Retired));
        assert!(resolve_database(
            &fixture.state.pgn_path_authority,
            collection.database.as_ref().unwrap(),
            PathOperation::DatabaseRead
        )
        .is_err());
        assert_eq!(
            std::fs::read(fixture.path("source")).unwrap(),
            body.as_bytes()
        );
        crate::file_workspace::write_workspace_file_metadata(
            fixture.workspace.clone(),
            file.clone(),
            WorkspaceMetadata {
                file_type: WorkspaceFileType::Game,
                tags: vec!["kept".into()],
            },
            app.state::<AppState>(),
        )
        .await
        .unwrap();
        assert_eq!(fixture.list()[0].id, collection.id);
        crate::file_workspace::trash_workspace_entry(
            fixture.workspace.clone(),
            file.clone(),
            app.state::<AppState>(),
        )
        .await
        .unwrap();
        assert!(!fixture.path("source").exists());
        assert!(
            fixture
                .service
                .refresh(
                    &fixture.state.pgn_path_authority,
                    id,
                    &CancellationToken::new()
                )
                .is_err(),
            "trashed source was still advertised as a current collection"
        );
        crate::file_workspace::restore_workspace_entry(
            fixture.workspace.clone(),
            file,
            app.state::<AppState>(),
        )
        .await
        .unwrap();
        assert_eq!(fixture.list()[0].id, collection.id);
        assert_eq!(
            std::fs::read(fixture.path("source")).unwrap(),
            body.as_bytes()
        );
    }

    #[test]
    fn two_game_range_is_omitted_from_linked_projection() {
        let fixture = Fixture::new();
        fixture.create("games", "1. e4 *\n\n1. d4 *\n", WorkspaceFileType::Game);
        let collection = fixture.list().pop().unwrap();
        assert_eq!(collection.omitted, 1);
        assert!(fixture.rows(&collection).is_empty());
    }

    #[test]
    fn cancellation_during_two_game_projection_fails_the_rebuild() {
        let fixture = Fixture::new();
        fixture.create("games", "1. e4 *\n\n1. d4 *\n", WorkspaceFileType::Game);
        let collection = fixture.list().pop().unwrap();
        let id = Uuid::parse_str(&collection.id).unwrap();
        std::fs::write(fixture.path("games"), "1. c4 *\n\n1. d5 *\n").unwrap();
        let token = CancellationToken::new();
        let cancel = token.clone();
        *fixture.service.rebuild_hook.lock().unwrap() = Some(Box::new(move || {
            cancel.cancel();
            Ok(())
        }));
        assert!(matches!(
            fixture
                .service
                .refresh(&fixture.state.pgn_path_authority, id, &token),
            Err(Error::Cancellation)
        ));
        *fixture.service.rebuild_hook.lock().unwrap() = None;
        let (generation, omitted) = fixture
            .service
            .refresh(
                &fixture.state.pgn_path_authority,
                id,
                &CancellationToken::new(),
            )
            .unwrap();
        assert_eq!(omitted, 1);
        assert_eq!(fixture.list().pop().unwrap().generation, generation);
    }

    #[tokio::test]
    async fn empty_cleanup_keeps_a_refused_range_byte_identical() {
        use tauri::Manager;

        let fixture = Fixture::new();
        let body = "[Event \"A\"]\n\n*\n\n1. d4 *\n";
        fixture.create("games", body, WorkspaceFileType::Game);
        let collection = fixture.list().pop().unwrap();
        edit_linked_collection(
            collection.id,
            collection.generation,
            CollectionEdit::Cleanup {
                empty: true,
                duplicates: false,
            },
            fixture.app().state::<AppState>(),
        )
        .await
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(fixture.path("games")).unwrap(),
            body
        );
    }

    #[test]
    fn provider_export_returns_conflict_for_a_two_game_range() {
        let fixture = Fixture::new();
        let batches = fixture
            .service
            .root
            .ensure_child(OsStr::new("batches"))
            .unwrap();
        let path = batches.path().join("two-game.pgn");
        std::fs::write(&path, "1. e4 *\n\n1. d4 *\n").unwrap();
        let handle = FileWorkspaceHandle::new(
            fixture
                .state
                .pgn_path_authority
                .with_mut(|authority| {
                    authority.get_or_create_persistent_file(
                        &path,
                        "two-game",
                        vec![PathOperation::ReadPgn],
                    )
                })
                .unwrap()
                .unwrap()
                .id,
        );
        let error = fixture
            .service
            .record_download(
                &fixture.state.pgn_path_authority,
                handle,
                "chesscom",
                "player",
                None,
                &CancellationToken::new(),
            )
            .unwrap_err();
        assert!(
            matches!(error, Error::Conflict(_)),
            "expected export conflict, got {error:?}"
        );
    }
}
