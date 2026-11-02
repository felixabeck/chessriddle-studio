use super::*;

pub(super) fn test_game_stamp(state: &AppState, file: &DatabaseHandle, game_id: i32) -> String {
    let target =
        resolve_database(&state.pgn_path_authority, file, PathOperation::DatabaseRead).unwrap();
    let mut db = state.database_repository.connection(&target, None).unwrap();
    game_row_stamp(&games::table.find(game_id).first::<Game>(&mut *db).unwrap())
}

const ORIGINAL: &str = "[White \"White\"]\n[Black \"Black\"]\n[Result \"*\"]\n\n1. e4 e5 *";

#[test]
fn row_stamps_cover_every_column_and_unambiguous_optional_fields() {
    let original = Game::default();
    let stamp = game_row_stamp(&original);
    assert_eq!(stamp.len(), 64);
    assert!(stamp
        .bytes()
        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)));
    assert_eq!(stamp, game_row_stamp(&Game::default()));
    macro_rules! changed {
        ($field:ident, $value:expr) => {
            assert_ne!(
                stamp,
                game_row_stamp(&Game {
                    $field: $value,
                    ..Game::default()
                }),
                stringify!($field)
            );
        };
    }
    changed!(id, 1);
    changed!(event_id, 1);
    changed!(site_id, 1);
    changed!(date, Some(String::new()));
    changed!(time, Some(String::new()));
    changed!(round, Some(String::new()));
    changed!(white_id, 1);
    changed!(white_elo, Some(0));
    changed!(black_id, 1);
    changed!(black_elo, Some(0));
    changed!(white_material, 1);
    changed!(black_material, 1);
    changed!(result, Some(String::new()));
    changed!(time_control, Some(String::new()));
    changed!(eco, Some(String::new()));
    changed!(ply_count, Some(0));
    changed!(fen, Some(String::new()));
    changed!(moves, vec![0]);
    changed!(pawn_home, 1);
    assert_ne!(
        game_row_stamp(&Game {
            date: Some("a".into()),
            time: Some("bc".into()),
            ..Game::default()
        }),
        game_row_stamp(&Game {
            date: Some("ab".into()),
            time: Some("c".into()),
            ..Game::default()
        }),
    );
}

#[test]
fn insert_read_lookup_and_compare_and_swap_share_the_stored_row_stamp() {
    let (_dir, app, handle, path) = blocking_database_case();
    let state = app.state::<AppState>();
    let token = CancellationToken::new();
    let inserted = insert_db_game_from_reader(
        &state.pgn_path_authority,
        &state.database_repository,
        &state.search_cache,
        handle.clone(),
        ORIGINAL.as_bytes(),
        &token,
    )
    .unwrap();
    let read = || {
        get_games_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            handle.clone(),
            GameQuery::new(),
            &token,
        )
        .unwrap()
        .data
        .remove(0)
    };
    let loaded = read();
    let mut unstamped = loaded.clone();
    unstamped.stamp = None;
    assert!(serde_json::to_value(unstamped)
        .unwrap()
        .get("stamp")
        .is_none());
    assert_eq!(inserted.id, loaded.id);
    assert_eq!(Some(&inserted.stamp), loaded.stamp.as_ref());
    match get_db_game_blocking(
        &state.pgn_path_authority,
        &state.database_repository,
        handle.clone(),
        inserted.id,
        None,
        &token,
    )
    .unwrap()
    {
        DbGameLookup::Found { game } => assert_eq!(game.stamp, loaded.stamp),
        DbGameLookup::Missing => panic!("inserted game missing"),
    }
    let write = |id, pgn: &str, stamp: &str| {
        write_db_game_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            &state.search_cache,
            handle.clone(),
            id,
            pgn.into(),
            stamp.into(),
            &token,
        )
    };
    let next_stamp = write(
        inserted.id,
        &ORIGINAL.replace("e4 e5", "d4 d5"),
        &inserted.stamp,
    )
    .unwrap();
    assert_eq!(Some(next_stamp.clone()), read().stamp);
    assert_ne!(next_stamp, inserted.stamp);
    let snapshot = || {
        let mut db = state
            .database_repository
            .connection(&test_target(&path), None)
            .unwrap();
        let row = games::table
            .find(inserted.id)
            .first::<Game>(&mut *db)
            .unwrap();
        let revision = info::table
            .filter(info::name.eq("DataRevision"))
            .select(info::value)
            .first::<Option<String>>(&mut *db)
            .unwrap();
        (serde_json::to_vec(&row).unwrap(), revision)
    };
    let before = snapshot();
    let key = seed_search_cache_for_database(&app, &path);
    assert!(matches!(
        write(inserted.id, ORIGINAL, &inserted.stamp),
        Err(Error::StaleGame)
    ));
    assert_eq!(snapshot(), before);
    assert!(state.search_cache.get_result(&key).is_some());
    assert!(matches!(
        write(i32::MAX, ORIGINAL, &next_stamp),
        Err(Error::GameNotFound(_))
    ));
    assert_eq!(snapshot(), before);
}
