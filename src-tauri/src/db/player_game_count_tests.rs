use super::*;
use diesel::connection::SimpleConnection;
use std::io::{Read, Seek, SeekFrom};
use tauri::Manager;

pub(super) fn assert_player_counts(db: &mut SqliteConnection) {
    for player in players::table.load::<Player>(db).unwrap() {
        let expected = if player.id == 0 {
            0
        } else {
            games::table
                .filter(
                    games::white_id
                        .eq(player.id)
                        .or(games::black_id.eq(player.id)),
                )
                .count()
                .get_result::<i64>(db)
                .unwrap()
        };
        assert_eq!(
            i64::from(player.game_count),
            expected,
            "player {}",
            player.id
        );
    }
}

fn player_query(name: Option<&str>, direction: SortDirection) -> PlayerQuery {
    PlayerQuery {
        options: QueryOptions {
            skip_count: false,
            page: Some(1),
            page_size: Some(25),
            sort: PlayerSort::Games,
            direction,
        },
        name: name.map(str::to_owned),
        name_match: None,
        range: None,
    }
}

#[test]
fn counts_cover_self_play_unknown_reassignment_and_rollback() {
    let mut db = SqliteConnection::establish(":memory:").unwrap();
    db.batch_execute(CREATE_TABLES_SQL).unwrap();
    db.batch_execute(
        "INSERT INTO Players(ID,Name) VALUES(1,'One'),(2,'Two'),(3,'Three');
        INSERT INTO Games(ID,WhiteID,BlackID) VALUES(1,1,1),(2,1,2),(3,0,2),(4,0,0);",
    )
    .unwrap();
    assert_player_counts(&mut db);
    assert_eq!(
        players::table
            .find(1)
            .select(players::game_count)
            .first::<i32>(&mut db)
            .unwrap(),
        2
    );
    for sql in [
        "UPDATE Games SET WhiteID=2,BlackID=1 WHERE ID=2",
        "UPDATE Games SET WhiteID=3,BlackID=3 WHERE ID=2",
        "UPDATE Games SET WhiteID=0,BlackID=0 WHERE ID=1",
        "DELETE FROM Games WHERE ID=3",
    ] {
        db.batch_execute(sql).unwrap();
        assert_player_counts(&mut db);
    }
    let before = players::table
        .order(players::id)
        .select(players::game_count)
        .load::<i32>(&mut db)
        .unwrap();
    let result: Result<(), Error> = db.transaction(|db| {
        db.batch_execute("DELETE FROM Games; INSERT INTO Games(WhiteID,BlackID) VALUES(1,2);")?;
        assert_player_counts(db);
        Err(Error::Cancellation)
    });
    assert!(matches!(result, Err(Error::Cancellation)));
    assert_player_counts(&mut db);
    assert_eq!(
        players::table
            .order(players::id)
            .select(players::game_count)
            .load::<i32>(&mut db)
            .unwrap(),
        before
    );
}

#[test]
fn production_players_games_sort_is_stable_in_both_directions() {
    let (_dir, app, handle, path) = blocking_database_case();
    let mut db = SqliteConnection::establish(path.to_str().unwrap()).unwrap();
    db.batch_execute(
        "INSERT INTO Players(ID,Name) VALUES(1,'Zulu'),(2,'Alpha'),(3,'Beta');
        INSERT INTO Games(WhiteID,BlackID) VALUES(1,2),(1,3),(3,3);",
    )
    .unwrap();
    let state = app.state::<AppState>();
    for (direction, expected) in [
        (SortDirection::Asc, vec![2, 3, 1]),
        (SortDirection::Desc, vec![3, 1, 2]),
    ] {
        let result = get_players_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            handle.clone(),
            player_query(None, direction),
            &CancellationToken::new(),
        )
        .unwrap();
        assert_eq!(result.count, Some(3));
        assert_eq!(
            result.data.iter().map(|p| p.id).collect::<Vec<_>>(),
            expected
        );
    }
}

#[test]
fn filtered_players_keep_counts_for_empty_pages_and_honor_skip_count_and_elo() {
    let (_dir, app, handle, path) = blocking_database_case();
    let mut db = SqliteConnection::establish(path.to_str().unwrap()).unwrap();
    db.batch_execute(
        "INSERT INTO Players(ID,Name,Elo) VALUES(1,'Alpha',2000),(2,'Alpine',2400),(3,'Beta',2200),(4,NULL,NULL),(5,'',NULL);
        INSERT INTO Games(WhiteID,BlackID) VALUES(1,2),(2,3);",
    )
    .unwrap();
    let state = app.state::<AppState>();
    let run = |query| {
        get_players_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            handle.clone(),
            query,
            &CancellationToken::new(),
        )
        .unwrap()
    };
    let mut query = player_query(Some("al"), SortDirection::Desc);
    query.options.page_size = Some(1);
    let first = run(query.clone());
    assert_eq!(first.count, Some(2));
    assert_eq!(first.data[0].id, 2);
    query.options.page = Some(2);
    let second = run(query.clone());
    assert_eq!(second.count, Some(2));
    assert_eq!(second.data[0].id, 1);
    query.options.page = Some(3);
    let empty = run(query.clone());
    assert_eq!(empty.count, Some(2));
    assert!(empty.data.is_empty());
    query.options.page = Some(1);
    query.options.skip_count = true;
    assert_eq!(run(query.clone()).count, None);
    query.options.skip_count = false;
    query.range = Some((2300, 2500));
    let rated = run(query.clone());
    assert_eq!(rated.count, Some(1));
    assert_eq!(rated.data[0].id, 2);
    query.name = Some("ALPHA".into());
    query.name_match = Some(PlayerNameMatch::Exact);
    assert_eq!(run(query.clone()).count, Some(0));
    query.range = None;
    assert_eq!(run(query.clone()).data[0].id, 1);
    query.name = Some("missing".into());
    assert_eq!(run(query.clone()).count, Some(0));
    query.name = Some("".into());
    query.name_match = None;
    assert_eq!(run(query.clone()).count, Some(4));
    query.name = None;
    assert_eq!(run(query.clone()).count, Some(5));
    query.name = Some("".into());
    query.name_match = Some(PlayerNameMatch::Exact);
    let exact_empty = run(query);
    assert_eq!(exact_empty.count, Some(1));
    assert_eq!(exact_empty.data[0].id, 5);
}

/// Run only against a disposable copy. Acquisition includes the production migration.
#[test]
#[ignore]
fn benchmark_mega_players_without_games_indexes() {
    let path = std::path::PathBuf::from(std::env::var("OPPONENT_PREP_BENCH_DB").unwrap());
    assert_eq!(path.file_name().unwrap(), "mega-work.db3");
    let registry = tempfile::tempdir().unwrap();
    let (app, handle) = database_app_with_grant(
        registry.path(),
        &path,
        "Mega benchmark",
        full_database_operations(),
    );
    let state = app.state::<AppState>();
    let start = Instant::now();
    get_player_blocking(
        &state.pgn_path_authority,
        &state.database_repository,
        handle.clone(),
        0,
    )
    .unwrap();
    println!("Mega migration/acquisition: {:?}", start.elapsed());
    delete_indexes_blocking(
        &state.pgn_path_authority,
        &state.database_repository,
        handle.clone(),
        &CancellationToken::new(),
    )
    .unwrap();
    for name in [None, Some(""), Some("kobert")] {
        let mut times = Vec::new();
        for iteration in 0..6 {
            let start = Instant::now();
            let result = get_players_blocking(
                &state.pgn_path_authority,
                &state.database_repository,
                handle.clone(),
                player_query(name, SortDirection::Desc),
                &CancellationToken::new(),
            )
            .unwrap();
            let elapsed = start.elapsed();
            assert!(!result.data.is_empty());
            println!("Mega games desc name={name:?} iteration={iteration}: {elapsed:?}, count={:?}, rows={}",result.count,result.data.len());
            if iteration > 0 {
                times.push(elapsed);
            }
        }
        assert!(times
            .iter()
            .all(|time| *time < std::time::Duration::from_millis(250)));
    }
}

/// Extract exact source bytes using the existing PGN parser's buffered position.
#[test]
#[ignore]
fn benchmark_conversion_count_triggers() {
    let source = std::path::PathBuf::from(std::env::var("OPPONENT_PREP_BENCH_PGN").unwrap());
    let scratch = std::path::PathBuf::from(std::env::var("OPPONENT_PREP_BENCH_DIR").unwrap());
    let corpus = scratch.join("first-100000.pgn");
    let mut reader = pgn_reader::BufferedReader::new(std::fs::File::open(&source).unwrap());
    for _ in 0..100_000 {
        assert!(reader.skip_game::<Importer>().unwrap());
    }
    let (buffer, mut file) = reader.into_inner().into_inner();
    let end = file.stream_position().unwrap() - buffer.get_ref().as_ref().len() as u64;
    file.seek(SeekFrom::Start(0)).unwrap();
    let mut output = std::fs::File::create(&corpus).unwrap();
    std::io::copy(&mut file.take(end), &mut output).unwrap();
    drop(output);
    println!(
        "Extracted 100000 games, {end} bytes to {}",
        corpus.display()
    );
    let mut measurements = [Vec::new(), Vec::new()];
    let run_dir = tempfile::Builder::new()
        .prefix("conversion-")
        .tempdir_in(&scratch)
        .unwrap();
    let mut expected_imported = None;
    for (iteration, triggers) in [false, true, true, false, false, true]
        .into_iter()
        .enumerate()
    {
        let path = run_dir.path().join(format!("conversion-{iteration}.db3"));
        let mut db = SqliteConnection::establish(path.to_str().unwrap()).unwrap();
        let start = Instant::now();
        let mut imported = 0;
        let mut context = ImportFileContext::default();
        db.transaction::<_,Error,_>(|db| {
            migrations::prepare_database(db,"Conversion benchmark","")?;
            if !triggers {
                db.batch_execute("DROP TRIGGER player_game_count_insert; DROP TRIGGER player_game_count_delete; DROP TRIGGER player_game_count_update;")?;
            }
            read_import_games(std::fs::File::open(&corpus)?, &mut context,None,&CancellationToken::new(),|game| {
                game.insert_to_db(db)?;
                imported += 1;
                Ok(())
            })?;
            create_required_indexes(db)?;
            refresh_derived_database_data(db)?;
            Ok(())
        }).unwrap();
        let elapsed = start.elapsed();
        assert_eq!(context.game, 100_000);
        assert!(imported > 0);
        assert_eq!(imported, *expected_imported.get_or_insert(imported));
        if triggers {
            assert_player_counts(&mut db);
        }
        println!(
            "Conversion triggers={triggers} iteration={iteration}: {elapsed:?}, games={imported}"
        );
        measurements[usize::from(triggers)].push(elapsed.as_secs_f64());
    }
    let means = measurements.map(|values| values.iter().sum::<f64>() / values.len() as f64);
    println!(
        "Conversion means without={}s with={}s overhead={} percent",
        means[0],
        means[1],
        (means[1] / means[0] - 1.0) * 100.0
    );
}
