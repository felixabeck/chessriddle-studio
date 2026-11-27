use std::sync::atomic::{AtomicUsize, Ordering};

use super::*;

fn photo_id(ch: char) -> String {
    std::iter::repeat_n(ch, crate::coach::scoresheet_photo_store::PHOTO_ID_HEX_LEN).collect()
}

fn game_pgn(white: &str, black: &str, moves: &str, photos_tag: Option<&str>) -> String {
    let mut pgn = format!(
        "[Event \"Club\"]\n[Site \"Berlin\"]\n[Date \"2026.11.26\"]\n[Round \"1\"]\n[White \"{white}\"]\n[Black \"{black}\"]\n[Result \"*\"]\n"
    );
    if let Some(tag) = photos_tag {
        pgn.push_str(&format!("[ScoresheetPhotos \"{tag}\"]\n"));
    }
    pgn.push('\n');
    pgn.push_str(moves);
    pgn.push('\n');
    pgn
}

fn read_db_game(state: &AppState, handle: &DatabaseHandle, game_id: i32) -> NormalizedGame {
    match get_db_game_blocking(
        &state.pgn_path_authority,
        &state.database_repository,
        handle.clone(),
        game_id,
        None,
        &CancellationToken::new(),
    )
    .unwrap()
    {
        DbGameLookup::Found { game } => *game,
        DbGameLookup::Missing => panic!("expected game {game_id} to exist"),
    }
}

fn with_read_db<T>(
    state: &AppState,
    handle: &DatabaseHandle,
    work: impl FnOnce(&mut SqliteConnection) -> T,
) -> T {
    let target = resolve_database(
        &state.pgn_path_authority,
        handle,
        PathOperation::DatabaseRead,
    )
    .unwrap();
    let mut db = state.database_repository.connection(&target, None).unwrap();
    work(&mut db)
}

fn table_exists_in_db(state: &AppState, handle: &DatabaseHandle) -> bool {
    with_read_db(state, handle, |db| {
        scoresheet_photos_table_exists(db).unwrap()
    })
}

fn stored_photos_in_db(state: &AppState, handle: &DatabaseHandle, game_id: i32) -> Option<String> {
    with_read_db(state, handle, |db| {
        load_game_scoresheet_photos(db, game_id).unwrap()
    })
}

fn count_photo_rows_in_db(state: &AppState, handle: &DatabaseHandle) -> i64 {
    with_read_db(state, handle, |db| {
        if !scoresheet_photos_table_exists(db).unwrap() {
            return 0;
        }
        scoresheet_photos::table.count().get_result(db).unwrap()
    })
}

#[test]
fn insert_and_write_store_update_and_remove_scoresheet_photos_row() {
    let (_dir, app, handle, _path) = blocking_database_case();
    let state = app.state::<AppState>();
    let token = CancellationToken::new();
    let photos_one = photo_id('a');
    let photos_two = format!("{},{}", photo_id('b'), photo_id('c'));

    let inserted = insert_db_game_from_reader(
        &state.pgn_path_authority,
        &state.database_repository,
        &state.search_cache,
        handle.clone(),
        game_pgn("Alice", "Bob", "1. e4 e5 *", Some(&photos_one)).as_bytes(),
        &token,
    )
    .unwrap();

    assert!(table_exists_in_db(&state, &handle));
    assert_eq!(
        stored_photos_in_db(&state, &handle, inserted.id),
        Some(photos_one.clone())
    );
    let loaded = read_db_game(&state, &handle, inserted.id);
    assert_eq!(
        loaded.scoresheet_photos.as_deref(),
        Some(photos_one.as_str())
    );
    assert_eq!(loaded.stamp.as_deref(), Some(inserted.stamp.as_str()));

    let updated_stamp = write_db_game_blocking(
        &state.pgn_path_authority,
        &state.database_repository,
        &state.search_cache,
        handle.clone(),
        inserted.id,
        game_pgn("Alice", "Bob", "1. e4 e5 *", Some(&photos_two)),
        inserted.stamp.clone(),
        &token,
    )
    .unwrap();
    assert_ne!(updated_stamp, inserted.stamp);
    assert_eq!(
        stored_photos_in_db(&state, &handle, inserted.id),
        Some(photos_two.clone())
    );
    assert_eq!(
        read_db_game(&state, &handle, inserted.id)
            .scoresheet_photos
            .as_deref(),
        Some(photos_two.as_str())
    );

    let cleared_stamp = write_db_game_blocking(
        &state.pgn_path_authority,
        &state.database_repository,
        &state.search_cache,
        handle.clone(),
        inserted.id,
        game_pgn("Alice", "Bob", "1. e4 e5 *", None),
        updated_stamp.clone(),
        &token,
    )
    .unwrap();
    assert_ne!(cleared_stamp, updated_stamp);
    assert_eq!(stored_photos_in_db(&state, &handle, inserted.id), None);
    assert_eq!(
        read_db_game(&state, &handle, inserted.id).scoresheet_photos,
        None
    );
}

#[test]
fn malformed_scoresheet_photos_tag_saves_without_row_and_clears_existing_row() {
    let (_dir, app, handle, _path) = blocking_database_case();
    let state = app.state::<AppState>();
    let token = CancellationToken::new();

    for malformed in [
        "not-a-hash",
        &"A".repeat(64),
        &format!("../{}", photo_id('a')),
        &format!(
            "{},{},{},{},{}",
            photo_id('a'),
            photo_id('b'),
            photo_id('c'),
            photo_id('d'),
            photo_id('e')
        ),
    ] {
        let inserted = insert_db_game_from_reader(
            &state.pgn_path_authority,
            &state.database_repository,
            &state.search_cache,
            handle.clone(),
            game_pgn("Alice", "Bob", "1. d4 d5 *", Some(malformed)).as_bytes(),
            &token,
        )
        .unwrap();
        assert!(!table_exists_in_db(&state, &handle));
        assert_eq!(stored_photos_in_db(&state, &handle, inserted.id), None);
        assert_eq!(
            read_db_game(&state, &handle, inserted.id).scoresheet_photos,
            None
        );
    }

    // Saving a malformed tag onto a game that had a valid photo row removes the row (fail-open).
    let valid = photo_id('1');
    let inserted = insert_db_game_from_reader(
        &state.pgn_path_authority,
        &state.database_repository,
        &state.search_cache,
        handle.clone(),
        game_pgn("Carol", "Dave", "1. c4 e5 *", Some(&valid)).as_bytes(),
        &token,
    )
    .unwrap();
    assert_eq!(
        stored_photos_in_db(&state, &handle, inserted.id),
        Some(valid)
    );

    write_db_game_blocking(
        &state.pgn_path_authority,
        &state.database_repository,
        &state.search_cache,
        handle.clone(),
        inserted.id,
        game_pgn("Carol", "Dave", "1. c4 e5 *", Some("invalid")),
        inserted.stamp,
        &token,
    )
    .unwrap();
    assert_eq!(stored_photos_in_db(&state, &handle, inserted.id), None);
}

#[test]
fn legacy_database_without_table_reads_exports_saves_and_creates_table_lazily() {
    let (dir, app, handle, _path) = blocking_database_case();
    let state = app.state::<AppState>();
    let token = CancellationToken::new();

    assert!(!table_exists_in_db(&state, &handle));

    let inserted = insert_db_game_from_reader(
        &state.pgn_path_authority,
        &state.database_repository,
        &state.search_cache,
        handle.clone(),
        game_pgn("White", "Black", "1. e4 e5 *", None).as_bytes(),
        &token,
    )
    .unwrap();
    assert!(!table_exists_in_db(&state, &handle));

    // Read (single and paged) succeeds without the table.
    let single = read_db_game(&state, &handle, inserted.id);
    assert_eq!(single.scoresheet_photos, None);
    let page = get_games_blocking(
        &state.pgn_path_authority,
        &state.database_repository,
        handle.clone(),
        GameQuery::new(),
        &token,
    )
    .unwrap();
    assert_eq!(page.data.len(), 1);
    assert_eq!(page.data[0].scoresheet_photos, None);

    // Export succeeds without the table.
    let export_path = dir.path().join("legacy-export.pgn");
    std::fs::write(&export_path, "").unwrap();
    let export_handle = grant_pgn_file(
        &app,
        &export_path,
        "legacy-export.pgn",
        vec![PathOperation::WritePgn],
    );
    export_to_pgn_blocking(
        &state.pgn_path_authority,
        &state.database_repository,
        handle.clone(),
        export_handle,
        &token,
    )
    .unwrap();
    let exported = std::fs::read_to_string(&export_path).unwrap();
    assert!(!exported.contains("ScoresheetPhotos"));
    assert!(!table_exists_in_db(&state, &handle));

    // Save without a tag succeeds without creating the table.
    let stamp_after_plain_save = write_db_game_blocking(
        &state.pgn_path_authority,
        &state.database_repository,
        &state.search_cache,
        handle.clone(),
        inserted.id,
        game_pgn("White", "Black", "1. e4 c5 *", None),
        inserted.stamp,
        &token,
    )
    .unwrap();
    assert!(!table_exists_in_db(&state, &handle));

    // First write with a valid tag lazily creates the table and stores the row.
    let photos = photo_id('7');
    write_db_game_blocking(
        &state.pgn_path_authority,
        &state.database_repository,
        &state.search_cache,
        handle.clone(),
        inserted.id,
        game_pgn("White", "Black", "1. e4 c5 *", Some(&photos)),
        stamp_after_plain_save,
        &token,
    )
    .unwrap();
    assert!(table_exists_in_db(&state, &handle));
    assert_eq!(
        stored_photos_in_db(&state, &handle, inserted.id),
        Some(photos)
    );
}

#[test]
fn photo_only_write_changes_stamp_and_refuses_stale_tab_save() {
    let (_dir, app, handle, _path) = blocking_database_case();
    let state = app.state::<AppState>();
    let token = CancellationToken::new();

    let inserted = insert_db_game_from_reader(
        &state.pgn_path_authority,
        &state.database_repository,
        &state.search_cache,
        handle.clone(),
        game_pgn("Alice", "Bob", "1. e4 e5 *", None).as_bytes(),
        &token,
    )
    .unwrap();

    // Photo-only write: moves and standard headers are identical, only ScoresheetPhotos changes.
    let photos_a = photo_id('a');
    let stamp_a = write_db_game_blocking(
        &state.pgn_path_authority,
        &state.database_repository,
        &state.search_cache,
        handle.clone(),
        inserted.id,
        game_pgn("Alice", "Bob", "1. e4 e5 *", Some(&photos_a)),
        inserted.stamp.clone(),
        &token,
    )
    .unwrap();
    assert_ne!(stamp_a, inserted.stamp);

    // A stale tab holding the pre-photo stamp is refused.
    let stale_err = write_db_game_blocking(
        &state.pgn_path_authority,
        &state.database_repository,
        &state.search_cache,
        handle.clone(),
        inserted.id,
        game_pgn("Alice", "Bob", "1. e4 e5 2. Nf3 *", None),
        inserted.stamp.clone(),
        &token,
    )
    .unwrap_err();
    assert!(matches!(stale_err, Error::StaleGame));

    // Removing the photo tag restores the exact original stamp.
    let stamp_removed = write_db_game_blocking(
        &state.pgn_path_authority,
        &state.database_repository,
        &state.search_cache,
        handle.clone(),
        inserted.id,
        game_pgn("Alice", "Bob", "1. e4 e5 *", None),
        stamp_a,
        &token,
    )
    .unwrap();
    assert_eq!(stamp_removed, inserted.stamp);
}

#[test]
fn convert_pgn_preserves_valid_scoresheet_photos_and_ignores_malformed() {
    let (dir, app, handle, _path) = blocking_database_case();
    tauri_specta::Builder::<tauri::test::MockRuntime>::new()
        .events(tauri_specta::collect_events!(ConvertProgress))
        .mount_events(&app);
    let state = app.state::<AppState>();
    let token = CancellationToken::new();

    let photos = format!("{},{}", photo_id('1'), photo_id('2'));
    let pgn_path = dir.path().join("import.pgn");
    let combined = format!(
        "{}\n{}\n{}",
        game_pgn("PhotoWhite", "PhotoBlack", "1. e4 e5 *", Some(&photos)),
        game_pgn("PlainWhite", "PlainBlack", "1. d4 d5 *", None),
        game_pgn("BadWhite", "BadBlack", "1. c4 c5 *", Some("not-hex")),
    );
    std::fs::write(&pgn_path, combined).unwrap();
    let pgn_handle = grant_pgn_file(&app, &pgn_path, "import.pgn", vec![PathOperation::ReadPgn]);

    convert_pgn_blocking(
        &state.pgn_path_authority,
        &state.database_repository,
        &state.search_cache,
        vec![pgn_handle],
        handle.clone(),
        None,
        app.clone(),
        "Imported".into(),
        None,
        "test-import-photos".into(),
        &token,
    )
    .unwrap();

    let games = get_games_blocking(
        &state.pgn_path_authority,
        &state.database_repository,
        handle.clone(),
        GameQuery::new(),
        &token,
    )
    .unwrap()
    .data;
    assert_eq!(games.len(), 3);
    assert_eq!(
        games
            .iter()
            .find(|g| g.white == "PhotoWhite")
            .and_then(|g| g.scoresheet_photos.as_deref()),
        Some(photos.as_str())
    );
    assert_eq!(
        games
            .iter()
            .find(|g| g.white == "PlainWhite")
            .and_then(|g| g.scoresheet_photos.as_deref()),
        None
    );
    assert_eq!(
        games
            .iter()
            .find(|g| g.white == "BadWhite")
            .and_then(|g| g.scoresheet_photos.as_deref()),
        None
    );
    assert_eq!(count_photo_rows_in_db(&state, &handle), 1);
}

#[test]
fn export_to_pgn_streams_scoresheet_photos_when_table_exists() {
    let (dir, app, handle, _path) = blocking_database_case();
    let state = app.state::<AppState>();
    let token = CancellationToken::new();
    let photos = format!("{},{}", photo_id('a'), photo_id('f'));

    insert_db_game_from_reader(
        &state.pgn_path_authority,
        &state.database_repository,
        &state.search_cache,
        handle.clone(),
        game_pgn("PhotoWhite", "PhotoBlack", "1. e4 e5 *", Some(&photos)).as_bytes(),
        &token,
    )
    .unwrap();
    insert_db_game_from_reader(
        &state.pgn_path_authority,
        &state.database_repository,
        &state.search_cache,
        handle.clone(),
        game_pgn("PlainWhite", "PlainBlack", "1. d4 d5 *", None).as_bytes(),
        &token,
    )
    .unwrap();

    let export_path = dir.path().join("with-photos.pgn");
    std::fs::write(&export_path, "").unwrap();
    let export_handle = grant_pgn_file(
        &app,
        &export_path,
        "with-photos.pgn",
        vec![PathOperation::WritePgn],
    );

    let counter = Arc::new(AtomicUsize::new(0));
    export::EXPORT_ROW_COUNT.with(|slot| *slot.borrow_mut() = Some(Arc::clone(&counter)));
    let result = export_to_pgn_blocking(
        &state.pgn_path_authority,
        &state.database_repository,
        handle.clone(),
        export_handle,
        &token,
    );
    export::EXPORT_ROW_COUNT.with(|slot| *slot.borrow_mut() = None);
    result.unwrap();

    assert_eq!(counter.load(Ordering::Relaxed), 2);
    let exported = std::fs::read_to_string(&export_path).unwrap();
    let expected_tag = format!("[ScoresheetPhotos \"{photos}\"]");
    assert_eq!(exported.matches(&expected_tag).count(), 1);
    assert_eq!(exported.matches("[ScoresheetPhotos ").count(), 1);
}

#[test]
fn deleting_game_and_empty_games_cascades_scoresheet_photos() {
    let (_dir, app, handle, _path) = blocking_database_case();
    let state = app.state::<AppState>();
    let token = CancellationToken::new();
    let photos = photo_id('9');

    let inserted = insert_db_game_from_reader(
        &state.pgn_path_authority,
        &state.database_repository,
        &state.search_cache,
        handle.clone(),
        game_pgn("Alice", "Bob", "1. e4 e5 *", Some(&photos)).as_bytes(),
        &token,
    )
    .unwrap();
    assert_eq!(count_photo_rows_in_db(&state, &handle), 1);

    delete_db_game_blocking(
        &state.pgn_path_authority,
        &state.database_repository,
        &state.search_cache,
        handle.clone(),
        inserted.id,
        &token,
    )
    .unwrap();
    assert_eq!(count_photo_rows_in_db(&state, &handle), 0);

    // Also verify delete_empty_games cascades ScoresheetPhotos.
    let target = resolve_database(
        &state.pgn_path_authority,
        &handle,
        PathOperation::DatabaseMutate,
    )
    .unwrap();
    {
        let mut db = state.database_repository.connection(&target, None).unwrap();
        let empty_id = TempGame {
            white_name: Some("EmptyW".into()),
            black_name: Some("EmptyB".into()),
            scoresheet_photos: Some(photos.clone()),
            ..Default::default()
        }
        .insert_to_db(&mut db)
        .unwrap();
        assert_eq!(
            load_game_scoresheet_photos(&mut db, empty_id).unwrap(),
            Some(photos)
        );
    }
    assert_eq!(count_photo_rows_in_db(&state, &handle), 1);

    delete_empty_games_blocking(
        &state.pgn_path_authority,
        &state.database_repository,
        &state.search_cache,
        handle.clone(),
        &token,
    )
    .unwrap();
    assert_eq!(count_photo_rows_in_db(&state, &handle), 0);
}

#[test]
fn duplicate_cleanup_keeps_photo_carrying_duplicate_and_preserves_lowest_id_for_plain_pairs() {
    let (_dir, app, handle, _path) = blocking_database_case();
    let state = app.state::<AppState>();
    let token = CancellationToken::new();
    let dup_photos = photo_id('d');
    let survivor_own_photos = photo_id('1');
    let other_dup_photos = photo_id('2');

    // Pair A: lower-ID game has no photos; higher-ID duplicate carries dup_photos -> higher-ID wins.
    let plain_a = insert_db_game_from_reader(
        &state.pgn_path_authority,
        &state.database_repository,
        &state.search_cache,
        handle.clone(),
        game_pgn("Alice", "Bob", "1. e4 e5 *", None).as_bytes(),
        &token,
    )
    .unwrap();
    let photo_a = insert_db_game_from_reader(
        &state.pgn_path_authority,
        &state.database_repository,
        &state.search_cache,
        handle.clone(),
        game_pgn("Alice", "Bob", "1. e4 e5 *", Some(&dup_photos)).as_bytes(),
        &token,
    )
    .unwrap();
    assert!(plain_a.id < photo_a.id);

    // Pair B: both duplicates carry photos -> lower-ID game wins and keeps its own photos.
    let survivor_b = insert_db_game_from_reader(
        &state.pgn_path_authority,
        &state.database_repository,
        &state.search_cache,
        handle.clone(),
        game_pgn("Carol", "Dave", "1. d4 d5 *", Some(&survivor_own_photos)).as_bytes(),
        &token,
    )
    .unwrap();
    let duplicate_b = insert_db_game_from_reader(
        &state.pgn_path_authority,
        &state.database_repository,
        &state.search_cache,
        handle.clone(),
        game_pgn("Carol", "Dave", "1. d4 d5 *", Some(&other_dup_photos)).as_bytes(),
        &token,
    )
    .unwrap();
    assert!(survivor_b.id < duplicate_b.id);

    // Pair C: neither duplicate carries photos -> lowest ID survives (unchanged behaviour).
    let plain_c1 = insert_db_game_from_reader(
        &state.pgn_path_authority,
        &state.database_repository,
        &state.search_cache,
        handle.clone(),
        game_pgn("Eve", "Frank", "1. c4 e5 *", None).as_bytes(),
        &token,
    )
    .unwrap();
    let plain_c2 = insert_db_game_from_reader(
        &state.pgn_path_authority,
        &state.database_repository,
        &state.search_cache,
        handle.clone(),
        game_pgn("Eve", "Frank", "1. c4 e5 *", None).as_bytes(),
        &token,
    )
    .unwrap();
    assert!(plain_c1.id < plain_c2.id);

    // Pair D: NULL Moves duplicates (matching existing PARTITION BY NULL-equality semantics).
    let null_photos = photo_id('9');
    let (null_plain_id, null_photo_id) = {
        let target = resolve_database(
            &state.pgn_path_authority,
            &handle,
            PathOperation::DatabaseMutate,
        )
        .unwrap();
        let mut db = state.database_repository.connection(&target, None).unwrap();
        db.batch_execute(
            "INSERT INTO Games (EventID, SiteID, WhiteID, BlackID, WhiteMaterial, BlackMaterial, Moves, PawnHome)
             VALUES (0, 0, 0, 0, 39, 39, NULL, 0);
             INSERT INTO Games (EventID, SiteID, WhiteID, BlackID, WhiteMaterial, BlackMaterial, Moves, PawnHome)
             VALUES (0, 0, 0, 0, 39, 39, NULL, 0);",
        )
        .unwrap();
        let ids: Vec<i32> = games::table
            .filter(games::white_id.eq(0))
            .select(games::id)
            .order(games::id.asc())
            .load(&mut *db)
            .unwrap();
        assert_eq!(ids.len(), 2);
        upsert_scoresheet_photos(&mut db, ids[1], &null_photos).unwrap();
        (ids[0], ids[1])
    };

    delete_duplicated_games_blocking(
        &state.pgn_path_authority,
        &state.database_repository,
        &state.search_cache,
        handle.clone(),
        &token,
    )
    .unwrap();

    // Pair A: higher-ID photo game survived; lower-ID plain duplicate was deleted.
    assert!(matches!(
        get_db_game_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            handle.clone(),
            plain_a.id,
            None,
            &token,
        )
        .unwrap(),
        DbGameLookup::Missing
    ));
    assert_eq!(
        stored_photos_in_db(&state, &handle, photo_a.id),
        Some(dup_photos.clone())
    );
    assert_eq!(
        read_db_game(&state, &handle, photo_a.id)
            .scoresheet_photos
            .as_deref(),
        Some(dup_photos.as_str())
    );

    // Pair B: lower-ID photo game survived; higher-ID duplicate and its photo row were deleted.
    assert_eq!(
        stored_photos_in_db(&state, &handle, survivor_b.id),
        Some(survivor_own_photos)
    );
    assert_eq!(stored_photos_in_db(&state, &handle, duplicate_b.id), None);

    // Pair C: lower-ID plain game survived; higher-ID duplicate was deleted.
    assert_eq!(read_db_game(&state, &handle, plain_c1.id).id, plain_c1.id);
    assert!(matches!(
        get_db_game_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            handle.clone(),
            plain_c2.id,
            None,
            &token,
        )
        .unwrap(),
        DbGameLookup::Missing
    ));

    // Pair D: NULL-Moves duplicates grouped as one partition; plain row deleted, photo row kept.
    let remaining_null_ids: Vec<i32> = with_read_db(&state, &handle, |db| {
        games::table
            .filter(games::id.eq_any([null_plain_id, null_photo_id]))
            .select(games::id)
            .order(games::id.asc())
            .load(db)
            .unwrap()
    });
    assert_eq!(remaining_null_ids, vec![null_photo_id]);
    assert_eq!(stored_photos_in_db(&state, &handle, null_plain_id), None);
    assert_eq!(
        stored_photos_in_db(&state, &handle, null_photo_id),
        Some(null_photos)
    );
    assert_eq!(count_photo_rows_in_db(&state, &handle), 3);
}

#[test]
fn duplicate_cleanup_skips_photo_join_when_table_absent_or_empty() {
    let (_dir, app, handle, _path) = blocking_database_case();
    let state = app.state::<AppState>();
    let token = CancellationToken::new();

    // Absent table: duplicate cleanup succeeds without creating ScoresheetPhotos.
    for _ in 0..2 {
        insert_db_game_from_reader(
            &state.pgn_path_authority,
            &state.database_repository,
            &state.search_cache,
            handle.clone(),
            game_pgn("Alice", "Bob", "1. e4 e5 *", None).as_bytes(),
            &token,
        )
        .unwrap();
    }
    assert!(!table_exists_in_db(&state, &handle));
    delete_duplicated_games_blocking(
        &state.pgn_path_authority,
        &state.database_repository,
        &state.search_cache,
        handle.clone(),
        &token,
    )
    .unwrap();
    assert!(!table_exists_in_db(&state, &handle));

    // Empty table: create and clear a photo row, then run duplicate cleanup on plain duplicates.
    let temp = insert_db_game_from_reader(
        &state.pgn_path_authority,
        &state.database_repository,
        &state.search_cache,
        handle.clone(),
        game_pgn("Temp", "Game", "1. c4 c5 *", Some(&photo_id('a'))).as_bytes(),
        &token,
    )
    .unwrap();
    delete_db_game_blocking(
        &state.pgn_path_authority,
        &state.database_repository,
        &state.search_cache,
        handle.clone(),
        temp.id,
        &token,
    )
    .unwrap();
    assert!(table_exists_in_db(&state, &handle));
    assert_eq!(count_photo_rows_in_db(&state, &handle), 0);

    insert_db_game_from_reader(
        &state.pgn_path_authority,
        &state.database_repository,
        &state.search_cache,
        handle.clone(),
        game_pgn("Alice", "Bob", "1. e4 e5 *", None).as_bytes(),
        &token,
    )
    .unwrap();
    delete_duplicated_games_blocking(
        &state.pgn_path_authority,
        &state.database_repository,
        &state.search_cache,
        handle.clone(),
        &token,
    )
    .unwrap();
    assert_eq!(count_photo_rows_in_db(&state, &handle), 0);
    let remaining = get_games_blocking(
        &state.pgn_path_authority,
        &state.database_repository,
        handle.clone(),
        GameQuery::new(),
        &token,
    )
    .unwrap()
    .data;
    assert_eq!(remaining.len(), 1);
}

#[test]
fn position_search_returns_scoresheet_photos_and_matching_stamp() {
    let (_dir, app, handle, _path) = blocking_database_case();
    tauri_specta::Builder::<tauri::test::MockRuntime>::new()
        .events(tauri_specta::collect_events!(
            crate::progress::ProgressEvent
        ))
        .mount_events(&app);
    let state = app.state::<AppState>();
    let token = CancellationToken::new();
    let photos = format!("{},{}", photo_id('a'), photo_id('b'));

    let pgn = format!(
        "[Event \"Club\"]\n[Site \"Berlin\"]\n[Date \"2026.11.26\"]\n[Round \"1\"]\n[White \"SearchWhite\"]\n[Black \"SearchBlack\"]\n[Result \"1-0\"]\n[ScoresheetPhotos \"{photos}\"]\n\n1. e4 e5 2. Nf3 1-0\n"
    );
    let inserted = insert_db_game_from_reader(
        &state.pgn_path_authority,
        &state.database_repository,
        &state.search_cache,
        handle.clone(),
        pgn.as_bytes(),
        &token,
    )
    .unwrap();

    let progress = crate::progress::JobProgress::new(app.clone(), "photo-search".into()).unwrap();
    let permit = state.new_request.clone().try_acquire_owned().unwrap();
    let query = GameQuery::new().position(search::PositionQueryJs {
        fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1".into(),
        type_: "exact".into(),
    });
    let (_openings, games) = search::search_position_blocking(
        &state.pgn_path_authority,
        &state.database_repository,
        &state.search_cache,
        permit,
        progress.lease(),
        app.clone(),
        handle,
        query,
        &token,
        None,
    )
    .unwrap();

    assert_eq!(games.len(), 1);
    assert_eq!(games[0].id, inserted.id);
    assert_eq!(games[0].scoresheet_photos.as_deref(), Some(photos.as_str()));
    assert_eq!(games[0].stamp.as_deref(), Some(inserted.stamp.as_str()));
}

#[test]
fn invalid_row_present_in_scoresheet_photos_table_is_dropped_on_read_and_export() {
    let (dir, app, handle, _path) = blocking_database_case();
    let state = app.state::<AppState>();
    let token = CancellationToken::new();

    let inserted = insert_db_game_from_reader(
        &state.pgn_path_authority,
        &state.database_repository,
        &state.search_cache,
        handle.clone(),
        game_pgn("TamperedWhite", "TamperedBlack", "1. e4 e5 *", None).as_bytes(),
        &token,
    )
    .unwrap();

    // Simulate a database modified outside Studio with a malformed Photos value.
    let target = resolve_database(
        &state.pgn_path_authority,
        &handle,
        PathOperation::DatabaseMutate,
    )
    .unwrap();
    {
        let mut db = state.database_repository.connection(&target, None).unwrap();
        upsert_scoresheet_photos(&mut db, inserted.id, "../not-a-valid-photo-id").unwrap();
    }

    let loaded = read_db_game(&state, &handle, inserted.id);
    assert_eq!(loaded.scoresheet_photos, None);

    let export_path = dir.path().join("tampered-export.pgn");
    std::fs::write(&export_path, "").unwrap();
    let export_handle = grant_pgn_file(
        &app,
        &export_path,
        "tampered-export.pgn",
        vec![PathOperation::WritePgn],
    );
    export_to_pgn_blocking(
        &state.pgn_path_authority,
        &state.database_repository,
        handle.clone(),
        export_handle,
        &token,
    )
    .unwrap();
    let exported = std::fs::read_to_string(&export_path).unwrap();
    assert!(!exported.contains("ScoresheetPhotos"));

    // The stamp returned by the read hashes the raw stored photo row so CAS write_db_game
    // accepts it (switching normalize_games to hash the validated None would fail with StaleGame).
    let read_stamp = loaded.stamp.expect("read must include row stamp");
    assert_ne!(read_stamp, inserted.stamp);
    let cleaned_stamp = write_db_game_blocking(
        &state.pgn_path_authority,
        &state.database_repository,
        &state.search_cache,
        handle.clone(),
        inserted.id,
        game_pgn("TamperedWhite", "TamperedBlack", "1. e4 e5 *", None),
        read_stamp,
        &token,
    )
    .unwrap();
    assert_eq!(cleaned_stamp, inserted.stamp);
    assert_eq!(stored_photos_in_db(&state, &handle, inserted.id), None);
}

#[test]
fn load_scoresheet_photos_for_games_merges_multiple_chunks_and_observes_cancellation() {
    let mut db = SqliteConnection::establish(":memory:").unwrap();
    migrations::prepare_database(&mut db, "chunking", "").unwrap();

    let total = SCORESHEET_PHOTOS_BIND_CHUNK_SIZE + 5;
    let first_photo = photo_id('1');
    let second_chunk_photo = photo_id('2');
    let mut ids = Vec::with_capacity(total);
    for idx in 0..total {
        let photos = if idx == 0 {
            Some(first_photo.clone())
        } else if idx == SCORESHEET_PHOTOS_BIND_CHUNK_SIZE + 2 {
            Some(second_chunk_photo.clone())
        } else {
            None
        };
        let id = TempGame {
            scoresheet_photos: photos,
            ..Default::default()
        }
        .insert_to_db(&mut db)
        .unwrap();
        ids.push(id);
    }

    let merged =
        load_scoresheet_photos_for_games(&mut db, &ids, &CancellationToken::new()).unwrap();
    assert_eq!(merged.len(), 2);
    assert_eq!(merged.get(&ids[0]), Some(&first_photo));
    assert_eq!(
        merged.get(&ids[SCORESHEET_PHOTOS_BIND_CHUNK_SIZE + 2]),
        Some(&second_chunk_photo)
    );

    let cancelled = CancellationToken::new();
    cancelled.cancel();
    assert!(matches!(
        load_scoresheet_photos_for_games(&mut db, &ids, &cancelled),
        Err(Error::Cancellation)
    ));
}
