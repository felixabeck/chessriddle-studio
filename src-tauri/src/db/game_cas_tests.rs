use super::*;

pub(super) fn test_game_stamp(state: &AppState, file: &DatabaseHandle, game_id: i32) -> String {
    let target =
        resolve_database(&state.pgn_path_authority, file, PathOperation::DatabaseRead).unwrap();
    let mut db = state.database_repository.connection(&target, None).unwrap();
    game_row_stamp(&games::table.find(game_id).first::<Game>(&mut *db).unwrap())
}

const ORIGINAL: &str = "[White \"White\"]\n[Black \"Black\"]\n[Result \"*\"]\n\n1. e4 e5 *";

#[test]
fn owner_inference_thresholds_count_both_colours_and_exclude_placeholders() {
    for (label, total, black_games, white_games, expected) in [
        ("too small", 9, 9, 0, None),
        ("below threshold", 10, 7, 0, None),
        ("at threshold", 10, 8, 0, Some(BoardOrientation::Black)),
        ("owner white", 10, 0, 10, None),
        ("both dominant", 10, 8, 8, None),
        (
            "white below threshold",
            10,
            8,
            7,
            Some(BoardOrientation::Black),
        ),
    ] {
        let mut db = SqliteConnection::establish(":memory:").unwrap();
        migrations::prepare_database(&mut db, label, "").unwrap();
        let white = create_player(&mut db, "Target White").unwrap().id;
        let black = create_player(&mut db, "Target Black").unwrap().id;
        let mut target = 0;
        for i in 0..total {
            let w = if i < white_games { white } else { 0 };
            let b = if i < black_games { black } else { 0 };
            let id = insert_owner_sample(&mut db, w, b);
            if i == 0 {
                // This game is part of the bounded sample and supplies the candidates.
                diesel::update(games::table.find(id))
                    .set((games::white_id.eq(white), games::black_id.eq(black)))
                    .execute(&mut db)
                    .unwrap();
                target = id;
            }
        }
        assert_eq!(
            infer_owner_orientation(&mut db, target).unwrap(),
            expected,
            "{label}"
        );
    }

    for name in [None, Some("Unknown"), Some("?"), Some(""), Some("   ")] {
        let mut db = SqliteConnection::establish(":memory:").unwrap();
        migrations::prepare_database(&mut db, "placeholders", "").unwrap();
        let placeholder = name
            .map(|name| create_player(&mut db, name).unwrap().id)
            .unwrap_or(0);
        let mut target = 0;
        for i in 0..10 {
            let opponent = create_player(&mut db, &format!("Opponent {i}")).unwrap().id;
            target = insert_owner_sample(&mut db, opponent, placeholder);
        }
        assert_eq!(
            infer_owner_orientation(&mut db, target).unwrap(),
            None,
            "{name:?}"
        );
        diesel::update(games::table)
            .set((games::white_id.eq(placeholder), games::black_id.eq(0)))
            .execute(&mut db)
            .unwrap();
        let owner = create_player(&mut db, "Owner").unwrap().id;
        diesel::update(games::table)
            .set(games::black_id.eq(owner))
            .execute(&mut db)
            .unwrap();
        assert_eq!(
            infer_owner_orientation(&mut db, target).unwrap(),
            Some(BoardOrientation::Black),
            "{name:?}"
        );
        diesel::update(games::table)
            .set(games::white_id.eq(owner))
            .execute(&mut db)
            .unwrap();
        assert_eq!(
            infer_owner_orientation(&mut db, target).unwrap(),
            None,
            "self-play"
        );
    }
}

fn insert_owner_sample(db: &mut SqliteConnection, white_id: i32, black_id: i32) -> i32 {
    TempGame {
        white_name: players::table
            .find(white_id)
            .select(players::name)
            .first(db)
            .unwrap(),
        black_name: players::table
            .find(black_id)
            .select(players::name)
            .first(db)
            .unwrap(),
        ..Default::default()
    }
    .insert_to_db(db)
    .unwrap()
}

#[test]
fn owner_inference_counts_participation_on_either_side_once_per_game() {
    let mut db = SqliteConnection::establish(":memory:").unwrap();
    migrations::prepare_database(&mut db, "both sides", "").unwrap();
    let owner = create_player(&mut db, "Owner").unwrap().id;
    let opponent = create_player(&mut db, "Opponent").unwrap().id;
    let target = insert_owner_sample(&mut db, opponent, owner);
    for _ in 0..7 {
        insert_owner_sample(&mut db, owner, 0);
    }
    for _ in 0..2 {
        insert_owner_sample(&mut db, 0, 0);
    }
    assert_eq!(
        infer_owner_orientation(&mut db, target).unwrap(),
        Some(BoardOrientation::Black)
    );
}

#[test]
fn owner_inference_samples_only_the_most_recent_games_without_player_indexes() {
    let mut db = SqliteConnection::establish(":memory:").unwrap();
    migrations::prepare_database(&mut db, "bounded", "").unwrap();
    let previous = create_player(&mut db, "Previous owner").unwrap().id;
    let current = create_player(&mut db, "Current owner").unwrap().id;
    let mut old_game = 0;
    let mut new_game = 0;
    for _ in 0..OWNER_INFERENCE_SAMPLE_CAP + 1 {
        old_game = insert_owner_sample(&mut db, 0, previous);
    }
    for _ in 0..OWNER_INFERENCE_SAMPLE_CAP {
        new_game = insert_owner_sample(&mut db, 0, current);
    }
    assert_eq!(infer_owner_orientation(&mut db, old_game).unwrap(), None);
    assert_eq!(
        infer_owner_orientation(&mut db, new_game).unwrap(),
        Some(BoardOrientation::Black)
    );
    assert!(matches!(
        infer_owner_orientation(&mut db, -1),
        Err(Error::GameNotFound(_))
    ));
}

#[cfg(unix)]
#[test]
fn owner_inference_reads_linked_collection_indexes() {
    use crate::file_workspace::WorkspaceFileType;
    let fixture = linked_collections::tests::Fixture::new();
    let pgn: String = (0..10)
        .map(|i| format!("[White \"Opponent {i}\"]\n[Black \"Owner\"]\n\n1. e4 e5 *\n\n"))
        .collect();
    fixture.create("owner", &pgn, WorkspaceFileType::Game);
    let collection = fixture.list().pop().unwrap();
    let handle = collection.database.unwrap();
    let state = &fixture.state;
    let token = CancellationToken::new();
    let row = get_games_blocking(
        &state.pgn_path_authority,
        &state.database_repository,
        handle.clone(),
        GameQuery::new(),
        &token,
    )
    .unwrap()
    .data
    .remove(0);
    assert_eq!(
        infer_game_orientation_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            handle.clone(),
            row.id,
            &token
        )
        .unwrap(),
        Some(BoardOrientation::Black)
    );
    token.cancel();
    assert!(matches!(
        infer_game_orientation_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            handle,
            row.id,
            &token
        ),
        Err(Error::Cancellation)
    ));
}

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
    changed!(orientation, Some("white".into()));
    changed!(orientation, Some("black".into()));
    assert_eq!(
        stamp,
        "b9815ed9853d2a9b971d64c41750bf9d8fc92b054bdf95da89a40dc7989039bb"
    );
    assert_ne!(
        game_row_stamp(&Game {
            orientation: Some("white".into()),
            ..Game::default()
        }),
        game_row_stamp(&Game {
            orientation: Some("black".into()),
            ..Game::default()
        }),
    );
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
