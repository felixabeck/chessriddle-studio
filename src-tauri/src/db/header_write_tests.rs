use super::*;
use tauri::Manager;

fn insert_header_test_game(state: &AppState, handle: &DatabaseHandle) -> i32 {
    let pgn = "\
[Event \"Original Event\"]\n\
[Site \"Original Site\"]\n\
[Date \"2025.01.01\"]\n\
[Round \"1\"]\n\
[White \"White Player\"]\n\
[Black \"Black Player\"]\n\
[Result \"1-0\"]\n\
\n\
1. e4 e5 1-0\n";
    insert_db_game_from_reader(
        &state.pgn_path_authority,
        &state.database_repository,
        &state.search_cache,
        handle.clone(),
        pgn.as_bytes(),
        &CancellationToken::new(),
    )
    .unwrap()
    .id
}

#[test]
fn write_db_game_headers_updates_only_header_columns_and_preserves_body_and_photos() {
    let (_dir, app, handle, database) = blocking_database_case();
    let state = app.state::<AppState>();
    let custom_pgn = "\
[Event \"Initial Event\"]\n\
[Site \"Initial Site\"]\n\
[Date \"2025.05.01\"]\n\
[UTCTime \"14:30:00\"]\n\
[Round \"1\"]\n\
[White \"Initial White\"]\n\
[Black \"Initial Black\"]\n\
[Result \"1-0\"]\n\
[WhiteElo \"2100\"]\n\
[BlackElo \"2050\"]\n\
[TimeControl \"600+0\"]\n\
[ECO \"C20\"]\n\
[SetUp \"1\"]\n\
[FEN \"rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1\"]\n\
[Orientation \"black\"]\n\
\n\
1... e5 2. Nf3 Nc6 1-0\n";
    let inserted = insert_db_game_from_reader(
        &state.pgn_path_authority,
        &state.database_repository,
        &state.search_cache,
        handle.clone(),
        custom_pgn.as_bytes(),
        &CancellationToken::new(),
    )
    .unwrap();
    let photo_tag = r#"[{"id":"photo-1","mime":"image/jpeg"}]"#;
    let before_row = {
        let mut db = state
            .database_repository
            .connection(&test_target(&database), None)
            .unwrap();
        upsert_scoresheet_photos(&mut db, inserted.id, photo_tag).unwrap();
        games::table
            .find(inserted.id)
            .first::<Game>(&mut *db)
            .unwrap()
    };
    let initial_stamp = game_row_stamp_with_photos(&before_row, Some(photo_tag));

    let returned_stamp = write_db_game_headers_blocking(
        &state.pgn_path_authority,
        &state.database_repository,
        &state.search_cache,
        handle.clone(),
        inserted.id,
        DbGameHeadersUpdate {
            white: Some("  Carlsen, Magnus  ".into()),
            black: Some("  Caruana, Fabiano  ".into()),
            white_elo: Some(2830),
            black_elo: Some(2805),
            event: Some("  Candidates  ".into()),
            site: Some("  Toronto  ".into()),
            round: Some("  7.1  ".into()),
            date: Some("  2026.04.12  ".into()),
            result: Some(" 1/2-1/2 ".into()),
            time_control: Some("  5400+30  ".into()),
        },
        initial_stamp,
        &CancellationToken::new(),
    )
    .unwrap();

    let (after_row, after_photos) = {
        let mut db = state
            .database_repository
            .connection(&test_target(&database), None)
            .unwrap();
        let row = games::table
            .find(inserted.id)
            .first::<Game>(&mut *db)
            .unwrap();
        let photos = load_game_scoresheet_photos(&mut db, inserted.id).unwrap();
        (row, photos)
    };
    assert_eq!(
        returned_stamp,
        game_row_stamp_with_photos(&after_row, after_photos.as_deref())
    );

    let lookup = get_db_game_blocking(
        &state.pgn_path_authority,
        &state.database_repository,
        handle.clone(),
        inserted.id,
        None,
        &CancellationToken::new(),
    )
    .unwrap();
    let queries::DbGameLookup::Found { game } = lookup else {
        panic!("expected updated game to be found");
    };
    assert_eq!(game.stamp.as_deref(), Some(returned_stamp.as_str()));
    assert_eq!(game.white, "Carlsen, Magnus");
    assert_eq!(game.black, "Caruana, Fabiano");
    assert_eq!(game.white_elo, Some(2830));
    assert_eq!(game.black_elo, Some(2805));
    assert_eq!(game.event, "Candidates");
    assert_eq!(game.site, "Toronto");
    assert_eq!(game.round.as_deref(), Some("7.1"));
    assert_eq!(game.date.as_deref(), Some("2026.04.12"));
    assert!(game.result == Outcome::Draw);
    assert_eq!(game.time_control.as_deref(), Some("5400+30"));

    // Non-header columns and scoresheet photos are preserved untouched.
    assert_eq!(after_row.time, before_row.time);
    assert_eq!(after_row.eco, before_row.eco);
    assert_eq!(after_row.ply_count, before_row.ply_count);
    assert_eq!(after_row.white_material, before_row.white_material);
    assert_eq!(after_row.black_material, before_row.black_material);
    assert_eq!(after_row.fen, before_row.fen);
    assert_eq!(after_row.moves, before_row.moves);
    assert_eq!(after_row.pawn_home, before_row.pawn_home);
    assert_eq!(after_row.orientation, before_row.orientation);
    assert_eq!(after_photos.as_deref(), Some(photo_tag));
}

#[test]
fn write_db_game_headers_rejects_stale_stamp_and_unknown_game() {
    let (_dir, app, handle, _database) = blocking_database_case();
    let state = app.state::<AppState>();
    let game_id = insert_header_test_game(&state, &handle);
    let original_stamp = test_game_stamp(&state, &handle, game_id);

    let stale = write_db_game_headers_blocking(
        &state.pgn_path_authority,
        &state.database_repository,
        &state.search_cache,
        handle.clone(),
        game_id,
        DbGameHeadersUpdate {
            event: Some("Should Not Apply".into()),
            ..DbGameHeadersUpdate::default()
        },
        "wrong-stamp".into(),
        &CancellationToken::new(),
    );
    assert!(matches!(stale, Err(Error::StaleGame)));
    assert_eq!(test_game_stamp(&state, &handle, game_id), original_stamp);

    let missing = write_db_game_headers_blocking(
        &state.pgn_path_authority,
        &state.database_repository,
        &state.search_cache,
        handle.clone(),
        game_id + 999,
        DbGameHeadersUpdate::default(),
        original_stamp,
        &CancellationToken::new(),
    );
    assert!(matches!(missing, Err(Error::GameNotFound(_))));
}

#[cfg(unix)]
#[test]
fn write_db_game_headers_refuses_active_linked_collection_index_without_changing_row() {
    use crate::file_workspace::WorkspaceFileType;

    let fixture = linked_collections::tests::Fixture::new();
    let pgn = "[Event \"Linked Event\"]\n[Site \"Berlin\"]\n[White \"White\"]\n[Black \"Black\"]\n[Result \"*\"]\n\n1. e4 e5 *\n";
    fixture.create("games", pgn, WorkspaceFileType::Game);
    let collection = fixture.list().pop().unwrap();
    let linked_db = collection.database.unwrap();
    let before_source = std::fs::read(fixture.path("games")).unwrap();
    let state = &fixture.state;
    let before_games = get_games_blocking(
        &state.pgn_path_authority,
        &state.database_repository,
        linked_db.clone(),
        GameQuery::new(),
        &CancellationToken::new(),
    )
    .unwrap();
    assert_eq!(before_games.data.len(), 1);
    let game_id = before_games.data[0].id;
    let stamp = before_games.data[0].stamp.clone().unwrap();

    let result = write_db_game_headers_blocking(
        &state.pgn_path_authority,
        &state.database_repository,
        &state.search_cache,
        linked_db.clone(),
        game_id,
        DbGameHeadersUpdate {
            event: Some("Should Not Apply".into()),
            ..DbGameHeadersUpdate::default()
        },
        stamp.clone(),
        &CancellationToken::new(),
    );
    assert!(matches!(result, Err(Error::Conflict(_))));
    assert_eq!(std::fs::read(fixture.path("games")).unwrap(), before_source);

    let after_games = get_games_blocking(
        &state.pgn_path_authority,
        &state.database_repository,
        linked_db,
        GameQuery::new(),
        &CancellationToken::new(),
    )
    .unwrap();
    assert_eq!(after_games.data.len(), 1);
    assert_eq!(after_games.data[0].stamp.as_deref(), Some(stamp.as_str()));
    assert_eq!(after_games.data[0].event, "Linked Event");
}

#[test]
fn write_db_game_headers_maps_unknown_markers_and_escapes_event_and_site() {
    let (_dir, app, handle, database) = blocking_database_case();
    let state = app.state::<AppState>();
    let game_id = insert_header_test_game(&state, &handle);
    let stamp = test_game_stamp(&state, &handle, game_id);

    let stamp = write_db_game_headers_blocking(
        &state.pgn_path_authority,
        &state.database_repository,
        &state.search_cache,
        handle.clone(),
        game_id,
        DbGameHeadersUpdate {
            white: Some(String::new()),
            black: Some("?".into()),
            event: Some("?".into()),
            site: Some(String::new()),
            round: Some("?".into()),
            date: Some(String::new()),
            result: Some(String::new()),
            time_control: Some("?".into()),
            ..DbGameHeadersUpdate::default()
        },
        stamp,
        &CancellationToken::new(),
    )
    .unwrap();

    let row = {
        let mut db = state
            .database_repository
            .connection(&test_target(&database), None)
            .unwrap();
        games::table.find(game_id).first::<Game>(&mut *db).unwrap()
    };
    assert_eq!(row.white_id, 0);
    assert_eq!(row.black_id, 0);
    assert_eq!(row.event_id, 0);
    assert_eq!(row.site_id, 0);
    assert_eq!(row.round, None);
    assert_eq!(row.date, None);
    assert_eq!(row.result, None);
    assert_eq!(row.time_control, None);

    let decoded_event = r#"Open "Spring" \ A"#;
    let decoded_site = r#"Hall "North" \ 2"#;
    write_db_game_headers_blocking(
        &state.pgn_path_authority,
        &state.database_repository,
        &state.search_cache,
        handle.clone(),
        game_id,
        DbGameHeadersUpdate {
            event: Some(decoded_event.into()),
            site: Some(decoded_site.into()),
            ..DbGameHeadersUpdate::default()
        },
        stamp,
        &CancellationToken::new(),
    )
    .unwrap();

    let lookup = get_db_game_blocking(
        &state.pgn_path_authority,
        &state.database_repository,
        handle.clone(),
        game_id,
        None,
        &CancellationToken::new(),
    )
    .unwrap();
    let queries::DbGameLookup::Found { game } = lookup else {
        panic!("expected game to be found");
    };
    assert_eq!(game.event, r#"Open \"Spring\" \\ A"#);
    assert_eq!(game.site, r#"Hall \"North\" \\ 2"#);
    let decode_pgn_tag_value = |value: &str| {
        let mut out = String::with_capacity(value.len());
        let mut chars = value.chars();
        while let Some(ch) = chars.next() {
            if ch == '\\' {
                if let Some(next) = chars.next() {
                    if next == '\\' || next == '"' {
                        out.push(next);
                    } else {
                        out.push(ch);
                        out.push(next);
                    }
                } else {
                    out.push(ch);
                }
            } else {
                out.push(ch);
            }
        }
        out
    };
    assert_eq!(decode_pgn_tag_value(&game.event), decoded_event);
    assert_eq!(decode_pgn_tag_value(&game.site), decoded_site);
}

#[test]
fn write_db_game_headers_validates_inputs_and_handles_partial_and_legacy_dates() {
    let (_dir, app, handle, database) = blocking_database_case();
    let state = app.state::<AppState>();
    let game_id = insert_header_test_game(&state, &handle);
    let initial_stamp = test_game_stamp(&state, &handle, game_id);

    let invalid_cases = [
        DbGameHeadersUpdate {
            white: Some("Carlsen\nMagnus".into()),
            ..DbGameHeadersUpdate::default()
        },
        DbGameHeadersUpdate {
            event: Some("Event\rName".into()),
            ..DbGameHeadersUpdate::default()
        },
        DbGameHeadersUpdate {
            white_elo: Some(-1),
            ..DbGameHeadersUpdate::default()
        },
        DbGameHeadersUpdate {
            black_elo: Some(4001),
            ..DbGameHeadersUpdate::default()
        },
        DbGameHeadersUpdate {
            result: Some("2-0".into()),
            ..DbGameHeadersUpdate::default()
        },
        DbGameHeadersUpdate {
            date: Some("2026.01.05\n".into()),
            ..DbGameHeadersUpdate::default()
        },
        DbGameHeadersUpdate {
            date: Some("2026.01.05\r".into()),
            ..DbGameHeadersUpdate::default()
        },
        DbGameHeadersUpdate {
            date: Some(r#"2026"01"01"#.into()),
            ..DbGameHeadersUpdate::default()
        },
        DbGameHeadersUpdate {
            date: Some("invalid".into()),
            ..DbGameHeadersUpdate::default()
        },
    ];
    for invalid in invalid_cases {
        let outcome = write_db_game_headers_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            &state.search_cache,
            handle.clone(),
            game_id,
            invalid,
            initial_stamp.clone(),
            &CancellationToken::new(),
        );
        assert!(matches!(outcome, Err(Error::InvalidInput(_))));
        assert_eq!(test_game_stamp(&state, &handle, game_id), initial_stamp);
    }

    let stamp = write_db_game_headers_blocking(
        &state.pgn_path_authority,
        &state.database_repository,
        &state.search_cache,
        handle.clone(),
        game_id,
        DbGameHeadersUpdate {
            date: Some("2026.??.??".into()),
            ..DbGameHeadersUpdate::default()
        },
        initial_stamp,
        &CancellationToken::new(),
    )
    .unwrap();
    {
        let mut db = state
            .database_repository
            .connection(&test_target(&database), None)
            .unwrap();
        let row = games::table.find(game_id).first::<Game>(&mut *db).unwrap();
        assert_eq!(row.date.as_deref(), Some("2026.??.??"));
    }

    let _stamp = write_db_game_headers_blocking(
        &state.pgn_path_authority,
        &state.database_repository,
        &state.search_cache,
        handle.clone(),
        game_id,
        DbGameHeadersUpdate {
            date: Some("2026.1.5".into()),
            ..DbGameHeadersUpdate::default()
        },
        stamp,
        &CancellationToken::new(),
    )
    .unwrap();
    let legacy_stamp = {
        let mut db = state
            .database_repository
            .connection(&test_target(&database), None)
            .unwrap();
        let row = games::table.find(game_id).first::<Game>(&mut *db).unwrap();
        assert_eq!(row.date.as_deref(), Some("2026.01.05"));

        diesel::update(games::table.filter(games::id.eq(game_id)))
            .set(games::date.eq(Some("legacy/2026")))
            .execute(&mut *db)
            .unwrap();
        let legacy_row = games::table.find(game_id).first::<Game>(&mut *db).unwrap();
        game_row_stamp_with_photos(&legacy_row, None)
    };

    let after_legacy_stamp = write_db_game_headers_blocking(
        &state.pgn_path_authority,
        &state.database_repository,
        &state.search_cache,
        handle.clone(),
        game_id,
        DbGameHeadersUpdate {
            event: Some("Updated Event".into()),
            date: Some("legacy/2026".into()),
            ..DbGameHeadersUpdate::default()
        },
        legacy_stamp,
        &CancellationToken::new(),
    )
    .unwrap();
    {
        let mut db = state
            .database_repository
            .connection(&test_target(&database), None)
            .unwrap();
        let row = games::table.find(game_id).first::<Game>(&mut *db).unwrap();
        assert_eq!(row.date.as_deref(), Some("legacy/2026"));
    }

    let changed_invalid = write_db_game_headers_blocking(
        &state.pgn_path_authority,
        &state.database_repository,
        &state.search_cache,
        handle.clone(),
        game_id,
        DbGameHeadersUpdate {
            date: Some("still-invalid".into()),
            ..DbGameHeadersUpdate::default()
        },
        after_legacy_stamp,
        &CancellationToken::new(),
    );
    assert!(matches!(changed_invalid, Err(Error::InvalidInput(_))));
}
