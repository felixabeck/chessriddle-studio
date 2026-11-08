use super::*;
use std::collections::{BTreeMap, BTreeSet};

/// Independent Rust aggregation of O1, shared by production write-path tests.
pub(super) fn assert_event_summaries(db: &mut SqliteConnection) {
    let rows = games::table
        .select((
            games::event_id,
            games::site_id,
            games::date,
            games::white_id,
            games::black_id,
            games::white_elo,
            games::black_elo,
        ))
        .load::<(i32, i32, Option<String>, i32, i32, Option<i32>, Option<i32>)>(db)
        .unwrap();
    for event in events::table.load::<Event>(db).unwrap() {
        let mut dates = Vec::new();
        let mut participants = BTreeSet::new();
        let mut sites = BTreeMap::<i32, usize>::new();
        let mut ratings = Vec::new();
        let mut count = 0;
        for (id, site, date, white, black, white_elo, black_elo) in &rows {
            if event.id == 0 || *id != event.id {
                continue;
            }
            count += 1;
            if let Some(date) = date.as_ref().filter(|date| !date.starts_with('?')) {
                dates.push(date.clone());
            }
            participants.extend([*white, *black].into_iter().filter(|id| *id != 0));
            if *site != 0 {
                *sites.entry(*site).or_default() += 1;
            }
            ratings.extend(
                [*white_elo, *black_elo]
                    .into_iter()
                    .flatten()
                    .filter(|elo| *elo > 0),
            );
        }
        dates.sort();
        let site = sites
            .iter()
            .max_by_key(|(id, count)| (**count, std::cmp::Reverse(**id)))
            .map_or(0, |(id, _)| *id);
        let avg = (!ratings.is_empty()).then(|| {
            (ratings.iter().map(|elo| f64::from(*elo)).sum::<f64>() / ratings.len() as f64).round()
                as i32
        });
        assert_eq!(
            (
                event.start_date,
                event.end_date,
                event.site_id,
                event.game_count,
                event.player_count,
                event.avg_elo
            ),
            (
                dates.first().cloned(),
                dates.last().cloned(),
                site,
                count,
                participants.len() as i32,
                avg
            ),
            "event {}",
            event.id
        );
    }
    assert_eq!(
        diesel::select(diesel::dsl::sql::<diesel::sql_types::BigInt>(
            "(SELECT COUNT(*) FROM EventSummaryDirty)"
        ))
        .get_result::<i64>(db)
        .unwrap(),
        0
    );
}

#[test]
fn summaries_cover_edges_dirty_reassignment_and_last_game_deletion() {
    let mut db = SqliteConnection::establish(":memory:").unwrap();
    db.batch_execute(CREATE_TABLES_SQL).unwrap();
    db.batch_execute(
        "INSERT INTO Events(ID,Name) VALUES(1,'Partial'),(2,'Unknown only'),(3,'Empty');
         INSERT INTO Sites(ID,Name) VALUES(1,'Low'),(2,'High');
         INSERT INTO Players(ID,Name) VALUES(1,'One'),(2,'Two'),(3,'Three');
         INSERT INTO Games(ID,EventID,SiteID,Date,WhiteID,BlackID,WhiteElo,BlackElo) VALUES
         (1,1,2,'2016.08.01',1,1,2000,0),
         (2,1,1,'2016.??.??',1,2,NULL,2001),
         (3,1,0,'????.??.??',0,3,-1,NULL),
         (4,2,0,NULL,0,0,0,NULL),
         (5,0,1,'2026.01.01',1,2,3000,3000);",
    )
    .unwrap();
    db.transaction::<_, Error, _>(|db| {
        update_database_counts(db)?;
        Ok(())
    })
    .unwrap();
    assert_event_summaries(&mut db);
    let partial = events::table.find(1).first::<Event>(&mut db).unwrap();
    assert_eq!(partial.start_date.as_deref(), Some("2016.08.01"));
    assert_eq!(partial.end_date.as_deref(), Some("2016.??.??"));
    assert_eq!(partial.avg_elo, Some(2001));
    assert_eq!(partial.site_id, 1);
    // An unrelated event is deliberately poisoned to prove refresh is dirty-only.
    db.batch_execute("UPDATE Events SET GameCount=123 WHERE ID=3;")
        .unwrap();
    db.transaction::<_,Error,_>(|db| {
        db.batch_execute("UPDATE Games SET EventID=2, SiteID=1, Date='2020.??.??', WhiteID=2, BlackID=2, WhiteElo=1700, BlackElo=NULL WHERE ID=1;")?;
        update_database_counts(db)
    }).unwrap();
    assert_eq!(
        events::table
            .find(3)
            .select(events::game_count)
            .first::<i32>(&mut db)
            .unwrap(),
        123
    );
    db.batch_execute("UPDATE Events SET GameCount=0 WHERE ID=3;")
        .unwrap();
    assert_event_summaries(&mut db);
    for sql in [
        "DELETE FROM Games WHERE EventID=1",
        "DELETE FROM Games WHERE EventID=2",
    ] {
        db.transaction::<_, Error, _>(|db| {
            db.batch_execute(sql)?;
            update_database_counts(db)
        })
        .unwrap();
        assert_event_summaries(&mut db);
    }
}

fn query(sort: TournamentSort, direction: SortDirection, page: i32) -> TournamentQuery {
    TournamentQuery {
        options: QueryOptions {
            sort,
            direction,
            page: Some(page),
            page_size: Some(2),
            skip_count: false,
        },
        name: None,
    }
}

#[test]
fn production_read_dto_all_sorts_nulls_ties_pages_and_filter() {
    let (_dir, app, handle, path) = blocking_database_case();
    let mut db = SqliteConnection::establish(path.to_str().unwrap()).unwrap();
    db.batch_execute(
        "INSERT INTO Events(ID,Name) VALUES(1,'Zulu'),(2,'Alpha'),(3,'Beta'),(4,'Gamma'),(5,'Delta'),(6,NULL),(7,NULL),(8,'');
         INSERT INTO Sites(ID,Name) VALUES(1,'Berlin');
         INSERT INTO Players(ID,Name) VALUES(1,'One'),(2,'Two');
         INSERT INTO Games(EventID,SiteID,Date,WhiteID,BlackID,WhiteElo) VALUES(1,1,'2020.01.01',1,1,1500),(5,0,'????.??.??',0,0,NULL);
         INSERT INTO Games(EventID,SiteID,Date,WhiteID,BlackID,WhiteElo)
         SELECT ID,1,'2025.01.01',1,2,2000 FROM Events WHERE ID IN(2,3,6,7);
         INSERT INTO Games(EventID,SiteID,Date,WhiteID,BlackID,WhiteElo)
         SELECT ID,1,'2025.01.01',1,2,2000 FROM Events WHERE ID IN(2,3,6,7);"
    ).unwrap();
    db.transaction::<_, Error, _>(update_database_counts)
        .unwrap();
    let state = app.state::<AppState>();
    let run = |query| {
        get_tournaments_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            handle.clone(),
            query,
            &CancellationToken::new(),
        )
        .unwrap()
    };
    for (sort, asc, desc) in [
        (
            TournamentSort::Name,
            vec![2, 3, 5, 4, 1, 6, 7],
            vec![1, 4, 5, 3, 2, 6, 7],
        ),
        (
            TournamentSort::Date,
            vec![1, 2, 3, 6, 7, 5, 4],
            vec![2, 3, 6, 7, 1, 5, 4],
        ),
        (
            TournamentSort::Players,
            vec![5, 4, 1, 2, 3, 6, 7],
            vec![2, 3, 6, 7, 1, 5, 4],
        ),
        (
            TournamentSort::Games,
            vec![4, 5, 1, 2, 3, 6, 7],
            vec![2, 3, 6, 7, 5, 1, 4],
        ),
        (
            TournamentSort::AvgElo,
            vec![1, 2, 3, 6, 7, 5, 4],
            vec![2, 3, 6, 7, 1, 5, 4],
        ),
    ] {
        for (direction, expected) in [(SortDirection::Asc, asc), (SortDirection::Desc, desc)] {
            let mut ids = Vec::new();
            for page in 1..=4 {
                let result = run(query(sort.clone(), direction.clone(), page));
                assert_eq!(result.count, Some(7));
                ids.extend(result.data.into_iter().map(|event| event.id));
            }
            assert_eq!(ids, expected, "{sort:?} {direction:?}");
        }
    }
    let mut filtered = query(TournamentSort::Date, SortDirection::Desc, 1);
    filtered.name = Some("alp".into());
    let result = run(filtered.clone());
    assert_eq!(result.count, Some(1));
    let event = &result.data[0];
    assert_eq!(event.id, 2);
    assert_eq!(event.site.as_deref(), Some("Berlin"));
    assert_eq!(event.start_date.as_deref(), Some("2025.01.01"));
    assert_eq!(event.end_date, event.start_date);
    assert_eq!(
        (event.player_count, event.game_count, event.avg_elo),
        (2, 2, Some(2000))
    );
    filtered.options.page = Some(2);
    let empty = run(filtered.clone());
    assert_eq!(empty.count, Some(1));
    assert!(empty.data.is_empty());
    filtered.options.page = Some(1);
    filtered.options.skip_count = true;
    filtered.name = Some("Delta".into());
    let unknown = run(filtered);
    assert_eq!(unknown.count, None);
    assert_eq!(unknown.data[0].site, None);
}

#[test]
fn summary_failure_propagates_from_insert_and_rolls_back_games_and_summaries() {
    let (_dir, app, handle, path) = blocking_database_case();
    let state = app.state::<AppState>();
    let token = CancellationToken::new();
    let pgn = "[Event \"Rollback\"]\n[White \"One\"]\n[Black \"Two\"]\n\n1. e4 *";
    insert_db_game_from_reader(
        &state.pgn_path_authority,
        &state.database_repository,
        &state.search_cache,
        handle.clone(),
        pgn.as_bytes(),
        &token,
    )
    .unwrap();
    let mut db = SqliteConnection::establish(path.to_str().unwrap()).unwrap();
    assert_event_summaries(&mut db);
    db.batch_execute("CREATE TRIGGER reject_summary BEFORE UPDATE OF GameCount ON Events BEGIN SELECT RAISE(ABORT,'injected summary failure'); END;").unwrap();
    let result = insert_db_game_from_reader(
        &state.pgn_path_authority,
        &state.database_repository,
        &state.search_cache,
        handle,
        pgn.as_bytes(),
        &token,
    );
    assert!(result.is_err());
    assert_eq!(games::table.count().get_result::<i64>(&mut db).unwrap(), 1);
    assert_event_summaries(&mut db);
}

#[test]
fn production_edit_reassigns_every_summary_input_and_refreshes_both_events() {
    let (_dir, app, handle, path) = blocking_database_case();
    let state = app.state::<AppState>();
    let token = CancellationToken::new();
    let original="[Event \"Original\"]\n[Site \"Old site\"]\n[Date \"2016.08.01\"]\n[White \"One\"]\n[Black \"Two\"]\n[WhiteElo \"2000\"]\n[BlackElo \"2100\"]\n\n1. e4 *";
    let first = insert_db_game_from_reader(
        &state.pgn_path_authority,
        &state.database_repository,
        &state.search_cache,
        handle.clone(),
        original.as_bytes(),
        &token,
    )
    .unwrap();
    insert_db_game_from_reader(
        &state.pgn_path_authority,
        &state.database_repository,
        &state.search_cache,
        handle.clone(),
        original.as_bytes(),
        &token,
    )
    .unwrap();
    let mut stamp = first.stamp;
    let mut db = SqliteConnection::establish(path.to_str().unwrap()).unwrap();
    assert_event_summaries(&mut db);
    for replacement in [
        original
            .replace("Original", "New event")
            .replace("Old site", "New site")
            .replace("2016.08.01", "2025.??.??")
            .replace("One", "Three")
            .replace("Two", "Three")
            .replace("2000", "1800")
            .replace("2100", "0"),
        original
            .replace("Original", "New event")
            .replace("Old site", "Third site")
            .replace("2016.08.01", "????.??.??")
            .replace("2000", "0")
            .replace("2100", "0"),
    ] {
        stamp = write_db_game_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            &state.search_cache,
            handle.clone(),
            first.id,
            replacement,
            stamp,
            &token,
        )
        .unwrap();
        assert_event_summaries(&mut db);
        assert_eq!(
            events::table
                .filter(events::id.ne(0))
                .count()
                .get_result::<i64>(&mut db)
                .unwrap(),
            2
        );
    }
}

/// Run only on the orchestrator's disposable copy. Acquisition includes migration.
#[test]
#[ignore]
fn benchmark_mega_event_summaries() {
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
    let first = get_tournaments_blocking(
        &state.pgn_path_authority,
        &state.database_repository,
        handle.clone(),
        query(TournamentSort::Date, SortDirection::Desc, 1),
        &CancellationToken::new(),
    )
    .unwrap();
    let deep_page = (first.count.unwrap() / 25).max(1);
    for sort in [
        TournamentSort::Name,
        TournamentSort::Date,
        TournamentSort::Players,
        TournamentSort::Games,
        TournamentSort::AvgElo,
    ] {
        for direction in [SortDirection::Asc, SortDirection::Desc] {
            for page in [1, deep_page] {
                for iteration in 0..6 {
                    let mut query = query(sort.clone(), direction.clone(), page);
                    query.options.page_size = Some(25);
                    let start = Instant::now();
                    let result = get_tournaments_blocking(
                        &state.pgn_path_authority,
                        &state.database_repository,
                        handle.clone(),
                        query,
                        &CancellationToken::new(),
                    )
                    .unwrap();
                    let elapsed = start.elapsed();
                    println!("Mega {sort:?} {direction:?} page={page} iteration={iteration}: {elapsed:?}, rows={}",result.data.len());
                    assert!(!result.data.is_empty());
                    if iteration > 0 {
                        assert!(elapsed < std::time::Duration::from_millis(250));
                    }
                }
            }
        }
    }
}
