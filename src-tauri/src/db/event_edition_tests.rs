use super::*;
use diesel::connection::SimpleConnection;
use std::path::{Path, PathBuf};

#[test]
fn temp_game_import_keeps_years_and_summaries_separate() {
    let mut db = SqliteConnection::establish(":memory:").unwrap();
    db.batch_execute(CREATE_TABLES_SQL).unwrap();
    db.transaction::<_, Error, _>(|db| {
        for (date, white, elo) in [
            ("2023.01.01", "Earlier", 1600),
            ("2024.??.??", "Later", 2400),
        ] {
            TempGame {
                event_name: Some("Annual".into()),
                date: Some(date.into()),
                white_name: Some(white.into()),
                white_elo: Some(elo),
                ..Default::default()
            }
            .insert_to_db(db)?;
        }
        refresh_derived_database_data(db)
    })
    .unwrap();
    let editions = events::table
        .filter(events::name.eq("Annual"))
        .order(events::year)
        .load::<Event>(&mut db)
        .unwrap();
    assert_eq!(
        editions
            .iter()
            .map(|event| (
                event.year,
                event.game_count,
                event.player_count,
                event.avg_elo
            ))
            .collect::<Vec<_>>(),
        vec![(2023, 1, 1, Some(1600)), (2024, 1, 1, Some(2400))]
    );
    event_summary_tests::assert_event_summaries(&mut db);
}

#[test]
fn production_date_edit_moves_edition_and_removes_emptied_edition() {
    let (_dir, app, handle, path) = blocking_database_case();
    let state = app.state::<AppState>();
    let token = CancellationToken::new();
    let pgn =
        "[Event \"Annual\"]\n[Date \"2023.01.01\"]\n[White \"One\"]\n[Black \"Two\"]\n\n1. e4 *";
    let first = insert_db_game_from_reader(
        &state.pgn_path_authority,
        &state.database_repository,
        &state.search_cache,
        handle.clone(),
        pgn.as_bytes(),
        &token,
    )
    .unwrap();
    let mut db = SqliteConnection::establish(path.to_str().unwrap()).unwrap();
    let old_id = games::table
        .find(first.id)
        .select(games::event_id)
        .first::<i32>(&mut db)
        .unwrap();
    write_db_game_blocking(
        &state.pgn_path_authority,
        &state.database_repository,
        &state.search_cache,
        handle,
        first.id,
        pgn.replace("2023.01.01", "2024.??.??"),
        first.stamp,
        &token,
    )
    .unwrap();
    assert!(events::table
        .find(old_id)
        .first::<Event>(&mut db)
        .optional()
        .unwrap()
        .is_none());
    let edition = events::table
        .filter(events::name.eq("Annual"))
        .first::<Event>(&mut db)
        .unwrap();
    assert_eq!((edition.year, edition.game_count), (2024, 1));
    assert_eq!(
        games::table
            .find(first.id)
            .select(games::event_id)
            .first::<i32>(&mut db)
            .unwrap(),
        edition.id
    );
    event_summary_tests::assert_event_summaries(&mut db);
}

#[test]
fn production_name_sort_orders_editions_newest_first_in_both_directions() {
    let (_dir, app, handle, path) = blocking_database_case();
    let mut db = SqliteConnection::establish(path.to_str().unwrap()).unwrap();
    db.batch_execute(
        "INSERT INTO Events(ID,Name,Year) VALUES
        (1,'Annual',2023),(2,'Annual',2025),(3,'Annual',0),(4,'Before',2024),(5,'After',2024);",
    )
    .unwrap();
    let state = app.state::<AppState>();
    for (direction, expected) in [
        (SortDirection::Asc, vec![5, 2, 1, 3, 4]),
        (SortDirection::Desc, vec![4, 2, 1, 3, 5]),
    ] {
        let mut ids = Vec::new();
        for page in 1..=3 {
            let result = get_tournaments_blocking(
                &state.pgn_path_authority,
                &state.database_repository,
                handle.clone(),
                TournamentQuery {
                    options: QueryOptions {
                        sort: TournamentSort::Name,
                        direction: direction.clone(),
                        page: Some(page),
                        page_size: Some(2),
                        skip_count: false,
                    },
                    name: None,
                },
                &CancellationToken::new(),
            )
            .unwrap();
            assert_eq!(result.count, Some(5));
            ids.extend(result.data.into_iter().map(|event| event.id));
        }
        assert_eq!(ids, expected, "{direction:?}");
    }
}

fn upgrade_case() -> (
    tempfile::TempDir,
    tauri::AppHandle<tauri::test::MockRuntime>,
    DatabaseHandle,
    PathBuf,
) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("upgrade.db3");
    let mut db = SqliteConnection::establish(path.to_str().unwrap()).unwrap();
    db.batch_execute("PRAGMA foreign_keys=ON;").unwrap();
    db.batch_execute(&migrations::pre_event_edition_schema())
        .unwrap();
    db.batch_execute(
        "INSERT INTO Info(Name,Value) VALUES('Version','2.3.0');
        INSERT INTO Events(ID,Name) VALUES(7,'Annual');
        INSERT INTO Games(EventID,Date) VALUES(7,'2023.01.01'),(7,'2024.01.01');
        CREATE TRIGGER require_upgrade_foreign_keys BEFORE UPDATE OF EventID ON Games
        WHEN (SELECT foreign_keys FROM pragma_foreign_keys) != 1
        BEGIN SELECT RAISE(ABORT,'upgrade disabled foreign keys'); END;",
    )
    .unwrap();
    drop(db);
    let (app, handle) =
        database_app_with_grant(dir.path(), &path, "Upgrade", full_database_operations());
    (dir, app, handle, path)
}

fn assert_upgrade_result(path: &Path, upgraded: bool, game_count: i64, data_revision: u64) {
    let mut db = SqliteConnection::establish(path.to_str().unwrap()).unwrap();
    let version = info::table
        .filter(info::name.eq("Version"))
        .select(info::value)
        .first::<Option<String>>(&mut db)
        .unwrap();
    assert_eq!(
        version.as_deref(),
        Some(if upgraded { "2.4.0" } else { "2.3.0" })
    );
    assert_eq!(
        games::table.count().get_result::<i64>(&mut db).unwrap(),
        game_count
    );
    assert_eq!(
        repository::read_data_revision(&mut db).unwrap(),
        data_revision
    );
    if upgraded {
        assert_eq!(
            events::table
                .filter(events::name.eq("Annual"))
                .count()
                .get_result::<i64>(&mut db)
                .unwrap(),
            2
        );
        event_summary_tests::assert_event_summaries(&mut db);
        assert_eq!(
            diesel::select(diesel::dsl::sql::<diesel::sql_types::BigInt>(
                "(SELECT COUNT(*) FROM pragma_foreign_key_check)"
            ))
            .get_result::<i64>(&mut db)
            .unwrap(),
            0
        );
    } else {
        assert_eq!(
            diesel::select(diesel::dsl::sql::<diesel::sql_types::BigInt>(
                "(SELECT COUNT(*) FROM pragma_table_info('Events') WHERE name='Year')"
            ))
            .get_result::<i64>(&mut db)
            .unwrap(),
            0
        );
    }
}

#[test]
fn validated_mutation_keeps_the_committed_upgrade_when_it_fails() {
    for succeeds in [false, true] {
        let (_dir, app, handle, path) = upgrade_case();
        let state = app.state::<AppState>();
        let target = resolve_database(
            &state.pgn_path_authority,
            &handle,
            PathOperation::DatabaseMutate,
        )
        .unwrap();
        let result = with_validated_mutation(
            &state.database_repository,
            &state.search_cache,
            &target,
            &CancellationToken::new(),
            &state.pgn_path_authority,
            &handle,
            |db| {
                assert_eq!(
                    diesel::select(diesel::dsl::sql::<diesel::sql_types::Integer>(
                        "(SELECT foreign_keys FROM pragma_foreign_keys)"
                    ))
                    .get_result::<i32>(db)?,
                    1
                );
                assert_eq!(
                    events::table
                        .filter(events::name.eq("Annual"))
                        .count()
                        .get_result::<i64>(db)?,
                    2
                );
                if succeeds {
                    Ok(())
                } else {
                    Err(Error::Conflict("injected caller failure".into()))
                }
            },
        );
        assert_eq!(result.is_ok(), succeeds);
        if !succeeds {
            assert!(
                matches!(result,Err(Error::Conflict(message)) if message=="injected caller failure")
            );
        }
        assert_upgrade_result(&path, true, 2, u64::from(succeeds));
    }
}

#[test]
fn failed_upgrade_rolls_back_every_step_and_can_be_retried() {
    let (_dir, app, handle, path) = upgrade_case();
    let mut db = SqliteConnection::establish(path.to_str().unwrap()).unwrap();
    // The Version marker is the last write, so every earlier step has run.
    db.batch_execute(
        "CREATE TRIGGER fail_upgrade_insert BEFORE INSERT ON Info WHEN NEW.Name='Version'
         BEGIN SELECT RAISE(ABORT,'injected upgrade failure'); END;
         CREATE TRIGGER fail_upgrade_update BEFORE UPDATE ON Info WHEN NEW.Name='Version'
         BEGIN SELECT RAISE(ABORT,'injected upgrade failure'); END;",
    )
    .unwrap();
    drop(db);
    let state = app.state::<AppState>();
    let target = resolve_database(
        &state.pgn_path_authority,
        &handle,
        PathOperation::DatabaseMutate,
    )
    .unwrap();
    let error = state
        .database_repository
        .connection(&target, None)
        .map(|_| ())
        .unwrap_err();
    assert!(
        format!("{error:?}").contains("injected upgrade failure"),
        "{error:?}"
    );
    assert_upgrade_result(&path, false, 2, 0);

    let mut db = SqliteConnection::establish(path.to_str().unwrap()).unwrap();
    db.batch_execute(
        "PRAGMA foreign_keys=ON;
         DROP TRIGGER fail_upgrade_insert;
         DROP TRIGGER fail_upgrade_update;",
    )
    .unwrap();
    // The repository keeps reporting this failed job, so retry on a fresh connection.
    db.immediate_transaction::<_, Error, _>(migrations::validate_existing_database)
        .unwrap();
    drop(db);
    assert_upgrade_result(&path, true, 2, 0);
}

#[test]
fn pgn_conversion_keeps_the_committed_upgrade_when_it_fails() {
    #[cfg(unix)]
    pgn_conversion_after_upgrade_case(false);
    pgn_conversion_after_upgrade_case(true);
}

fn pgn_conversion_after_upgrade_case(succeeds: bool) {
    let (dir, app, handle, path) = upgrade_case();
    tauri_specta::Builder::<tauri::test::MockRuntime>::new()
        .events(tauri_specta::collect_events!(ConvertProgress))
        .mount_events(&app);
    let source = dir.path().join("import.pgn");
    std::fs::write(
        &source,
        "[Event \"Annual\"]\n[Date \"2024.05.06\"]\n\n1. e4 *",
    )
    .unwrap();
    let file = grant_pgn_file(&app, &source, "import.pgn", vec![PathOperation::ReadPgn]);
    let state = app.state::<AppState>();
    #[cfg(unix)]
    let _failure = (!succeeds).then(repository::fail_next_revision_bump);
    let result = convert_pgn_blocking(
        &state.pgn_path_authority,
        &state.database_repository,
        &state.search_cache,
        vec![file],
        handle.clone(),
        None,
        app.clone(),
        "Upgrade".into(),
        None,
        handle.path_ref().id.clone(),
        &CancellationToken::new(),
    );
    assert_eq!(result.is_ok(), succeeds, "{result:?}");
    if !succeeds {
        assert!(
            matches!(result,Err(Error::Conflict(message)) if message=="injected revision bump failure")
        );
    }
    assert_upgrade_result(
        &path,
        true,
        if succeeds { 3 } else { 2 },
        u64::from(succeeds),
    );
}
