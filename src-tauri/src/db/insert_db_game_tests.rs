use super::*;
use tauri::Manager;

const PGN: &str = "[Event \"New game\"]\n[Site \"Berlin\"]\n[White \"White\"]\n[Black \"Black\"]\n[Result \"*\"]\n\n1. e4 e5 *\n";

fn insert(
    app: &tauri::AppHandle<tauri::test::MockRuntime>,
    file: DatabaseHandle,
    pgn: &str,
    cancellation: &CancellationToken,
) -> Result<InsertedDbGame, Error> {
    let state = app.state::<AppState>();
    insert_db_game_from_reader(
        &state.pgn_path_authority,
        &state.database_repository,
        &state.search_cache,
        file,
        pgn.as_bytes(),
        cancellation,
    )
}

#[test]
fn insert_db_game_round_trip_then_update_keeps_one_row_and_updates_counts() {
    let (_dir, app, handle, path) = blocking_database_case();
    let cached = seed_search_cache_for_database(&app, &path);
    let token = CancellationToken::new();
    let inserted = insert(&app, handle.clone(), PGN, &token).unwrap();
    let id = inserted.id;
    let state = app.state::<AppState>();
    assert!(state.search_cache.get_result(&cached).is_none());
    let read = || {
        get_games_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            handle.clone(),
            GameQuery::new(),
            &token,
        )
        .unwrap()
    };
    let games = read();
    assert_eq!(games.count, Some(1));
    assert_eq!(games.data[0].id, id);
    assert!(games.data[0].stamp.is_some());
    assert_eq!(games.data[0].white, "White");
    assert_eq!(games.data[0].black, "Black");
    assert_eq!(games.data[0].event, "New game");
    assert_eq!(games.data[0].site, "Berlin");
    assert_eq!(games.data[0].moves, "1. e4 e5 *");
    write_db_game_blocking(
        &state.pgn_path_authority,
        &state.database_repository,
        &state.search_cache,
        handle.clone(),
        id,
        PGN.replace("e4 e5", "d4 d5"),
        test_game_stamp(&state, &handle, id),
        &token,
    )
    .unwrap();
    let games = read();
    assert_eq!(games.count, Some(1));
    assert_eq!(games.data[0].id, id);
    assert_eq!(games.data[0].moves, "1. d4 d5 *");
    let target = resolve_database(
        &state.pgn_path_authority,
        &handle,
        PathOperation::DatabaseRead,
    )
    .unwrap();
    let mut db = state.database_repository.connection(&target, None).unwrap();
    for (name, expected) in [
        ("GameCount", "1"),
        ("PlayerCount", "3"),
        ("EventCount", "2"),
        ("SiteCount", "2"),
    ] {
        let value = info::table
            .filter(info::name.eq(name))
            .select(info::value)
            .first::<Option<String>>(&mut *db)
            .unwrap();
        assert_eq!(value.as_deref(), Some(expected), "{name}");
    }
}

#[tokio::test]
async fn insert_db_game_escaped_headers_preserve_native_spelling_and_export_valid_pgn() {
    let source = r#"[Event "Open \"A\" \\ Cup"]
[Site "Hall \"B\" \\ Wing"]
[White "Ada \"Ace\" \\ Labs"]
[Black "Bob \\ \"B\""]
[Result "*"]

1. e4 e5 *
"#;
    // The renderer's lexer contract carries raw escapes for parsePGN to decode.
    let tokens = crate::lexer::lex_pgn_sync(source).unwrap();
    for (index, (tag, value)) in [
        ("Event", r#"Open \"A\" \\ Cup"#),
        ("Site", r#"Hall \"B\" \\ Wing"#),
        ("White", r#"Ada \"Ace\" \\ Labs"#),
        ("Black", r#"Bob \\ \"B\""#),
    ]
    .into_iter()
    .enumerate()
    {
        assert_eq!(
            tokens[index],
            crate::lexer::Token::Header {
                tag: tag.into(),
                value: value.into(),
            }
        );
    }
    let (_dir, app, handle, _) = blocking_database_case();
    let token = CancellationToken::new();
    let id = insert(&app, handle.clone(), source, &token).unwrap().id;
    let state = app.state::<AppState>();
    let read = || {
        get_games_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            handle.clone(),
            GameQuery::new(),
            &token,
        )
        .unwrap()
    };
    let games = read();
    assert_eq!(games.count, Some(1));
    assert_eq!(games.data[0].id, id);
    assert_eq!(games.data[0].event, r#"Open \"A\" \\ Cup"#);
    assert_eq!(games.data[0].site, r#"Hall \"B\" \\ Wing"#);
    assert_eq!(games.data[0].white, "Ada \"Ace\" \\ Labs");
    assert_eq!(games.data[0].black, "Bob \\ \"B\"");
    assert_eq!(games.data[0].moves, "1. e4 e5 *");

    #[cfg(unix)]
    {
        let path = _dir.path().join("escaped.pgn");
        std::fs::write(&path, b"old").unwrap();
        let destination = grant_pgn_file(&app, &path, "escaped.pgn", vec![PathOperation::WritePgn]);
        export_to_pgn(handle.clone(), destination, app.state::<AppState>())
            .await
            .unwrap();
        let exported = std::fs::read_to_string(path).unwrap();
        for line in source.lines().take(4) {
            assert!(exported.contains(line), "{exported}");
        }
        let next_id = insert(&app, handle.clone(), &exported, &token).unwrap().id;
        assert_ne!(next_id, id);
        let roundtrip = read();
        assert_eq!(roundtrip.count, Some(2));
        for game in roundtrip.data {
            assert_eq!(game.event, games.data[0].event);
            assert_eq!(game.site, games.data[0].site);
            assert_eq!(game.white, games.data[0].white);
            assert_eq!(game.black, games.data[0].black);
            assert_eq!(game.moves, games.data[0].moves);
        }
    }
}

#[test]
fn insert_db_game_rejects_empty_and_cancelled_input_without_rows() {
    let (_dir, app, handle, path) = blocking_database_case();
    for pgn in [
        "",
        "[Event \"Empty\"]\n\n*",
        "[Event \"Empty\"]\n\n{comment} *",
    ] {
        assert!(matches!(
            insert(&app, handle.clone(), pgn, &CancellationToken::new()),
            Err(Error::NoMovesFound)
        ));
    }
    let token = CancellationToken::new();
    token.cancel();
    assert!(matches!(
        insert(&app, handle, PGN, &token),
        Err(Error::Cancellation)
    ));
    let mut db = SqliteConnection::establish(path.to_str().unwrap()).unwrap();
    assert_eq!(games::table.count().get_result::<i64>(&mut db).unwrap(), 0);
}

#[test]
fn insert_db_game_cancellation_during_parse_leaves_no_row() {
    struct CancelAfterRead<'a> {
        input: &'a [u8],
        cancellation: CancellationToken,
    }
    impl std::io::Read for CancelAfterRead<'_> {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            let count = buffer.len().min(64);
            let count = std::io::Read::read(&mut self.input, &mut buffer[..count])?;
            self.cancellation.cancel();
            Ok(count)
        }
    }
    let (_dir, app, handle, path) = blocking_database_case();
    let token = CancellationToken::new();
    let state = app.state::<AppState>();
    let result = insert_db_game_from_reader(
        &state.pgn_path_authority,
        &state.database_repository,
        &state.search_cache,
        handle,
        CancelAfterRead {
            input: PGN.as_bytes(),
            cancellation: token.clone(),
        },
        &token,
    );
    assert!(matches!(result, Err(Error::Cancellation)));
    let mut db = SqliteConnection::establish(path.to_str().unwrap()).unwrap();
    assert_eq!(games::table.count().get_result::<i64>(&mut db).unwrap(), 0);
}

#[test]
fn insert_db_game_mutate_permits_and_create_refuses() {
    for (operation, permitted) in [
        (PathOperation::DatabaseMutate, true),
        (PathOperation::DatabaseCreate, false),
    ] {
        let (_dir, app, handle, path) = schema_database_case("authority", vec![operation]);
        let result = insert(&app, handle, PGN, &CancellationToken::new());
        assert_eq!(result.is_ok(), permitted, "{result:?}");
        let mut db = SqliteConnection::establish(path.to_str().unwrap()).unwrap();
        assert_eq!(
            games::table.count().get_result::<i64>(&mut db).unwrap(),
            i64::from(permitted)
        );
    }
}

#[test]
fn insert_db_game_failed_revision_bump_rolls_back_and_preserves_cache() {
    let (_dir, app, handle, path) = blocking_database_case();
    let mut db = SqliteConnection::establish(path.to_str().unwrap()).unwrap();
    update_info_count(&mut db, "DataRevision", i64::MAX).unwrap();
    drop(db);
    let state = app.state::<AppState>();
    let key = seed_search_cache_for_database(&app, &path);
    assert!(matches!(
        insert(&app, handle, PGN, &CancellationToken::new()),
        Err(Error::InvalidInput(_))
    ));
    assert!(state.search_cache.get_result(&key).is_some());
    let mut db = SqliteConnection::establish(path.to_str().unwrap()).unwrap();
    assert_eq!(games::table.count().get_result::<i64>(&mut db).unwrap(), 0);
    assert_eq!(
        players::table.count().get_result::<i64>(&mut db).unwrap(),
        1
    );
}

#[tokio::test]
async fn insert_db_game_convert_pgn_uses_the_shared_insert() {
    let (dir, app, handle, _) = blocking_database_case();
    tauri_specta::Builder::<tauri::test::MockRuntime>::new()
        .events(tauri_specta::collect_events!(ConvertProgress))
        .mount_events(&app);
    let path = dir.path().join("import.pgn");
    std::fs::write(&path, PGN).unwrap();
    let source = grant_pgn_file(&app, &path, "import", vec![PathOperation::ReadPgn]);
    let state = app.state::<AppState>();
    convert_pgn_command_core(
        "insert-shared".into(),
        vec![source],
        handle.clone(),
        None,
        app.clone(),
        "Fixture".into(),
        None,
        None,
        "main",
        &state,
    )
    .await
    .unwrap();
    let id = insert(&app, handle.clone(), PGN, &CancellationToken::new())
        .unwrap()
        .id;
    let games = get_games_blocking(
        &state.pgn_path_authority,
        &state.database_repository,
        handle,
        GameQuery::new(),
        &CancellationToken::new(),
    )
    .unwrap();
    assert_eq!(games.count, Some(2));
    assert!(games.data.iter().any(|game| game.id == id));
    assert!(games.data.iter().all(|game| game.moves == "1. e4 e5 *"));
}

#[test]
fn insert_db_game_only_parses_the_first_game() {
    let (_dir, app, handle, _) = blocking_database_case();
    insert(
        &app,
        handle.clone(),
        &format!("{PGN}\n{PGN}"),
        &CancellationToken::new(),
    )
    .unwrap();
    let state = app.state::<AppState>();
    let games = get_games_blocking(
        &state.pgn_path_authority,
        &state.database_repository,
        handle,
        GameQuery::new(),
        &CancellationToken::new(),
    )
    .unwrap();
    assert_eq!(games.count, Some(1));
}

#[cfg(unix)]
#[test]
fn insert_db_game_refuses_a_linked_index_without_changing_its_source() {
    use crate::file_workspace::WorkspaceFileType;
    let fixture = linked_collections::tests::Fixture::new();
    fixture.create("games", PGN, WorkspaceFileType::Game);
    let collection = fixture.list().pop().unwrap();
    let before = std::fs::read(fixture.path("games")).unwrap();
    let state = &fixture.state;
    let result = insert_db_game_from_reader(
        &state.pgn_path_authority,
        &state.database_repository,
        &state.search_cache,
        collection.database.unwrap(),
        PGN.as_bytes(),
        &CancellationToken::new(),
    );
    assert!(matches!(result, Err(Error::Conflict(_))));
    assert_eq!(std::fs::read(fixture.path("games")).unwrap(), before);
}
