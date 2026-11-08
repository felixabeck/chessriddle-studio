use super::*;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, PartialEq, QueryableByName)]
struct SummarySnapshot {
    #[diesel(sql_type = diesel::sql_types::BigInt, column_name = ID)]
    id: i64,
    #[diesel(sql_type = Nullable<Text>, column_name = StartDate)]
    start_date: Option<String>,
    #[diesel(sql_type = Nullable<Text>, column_name = EndDate)]
    end_date: Option<String>,
    #[diesel(sql_type = diesel::sql_types::BigInt, column_name = SiteID)]
    site_id: i64,
    #[diesel(sql_type = diesel::sql_types::BigInt, column_name = GameCount)]
    game_count: i64,
    #[diesel(sql_type = diesel::sql_types::BigInt, column_name = PlayerCount)]
    player_count: i64,
    #[diesel(sql_type = Nullable<diesel::sql_types::BigInt>, column_name = AvgElo)]
    avg_elo: Option<i64>,
}

fn summary_snapshots(db: &mut SqliteConnection) -> Vec<SummarySnapshot> {
    sql_query("SELECT ID, StartDate, EndDate, SiteID, GameCount, PlayerCount, AvgElo FROM Events ORDER BY ID")
        .load(db)
        .unwrap()
}

/// Independent Rust aggregation of O1, shared by production write-path tests.
pub(super) fn assert_event_summaries(db: &mut SqliteConnection) {
    let rows = games::table
        .select((
            games::event_id,
            games::site_id,
            games::date,
            games::white_id,
            games::black_id,
            diesel::dsl::sql::<Nullable<diesel::sql_types::Double>>("WhiteElo"),
            diesel::dsl::sql::<Nullable<diesel::sql_types::Double>>("BlackElo"),
        ))
        .load::<(i32, i32, Option<String>, i32, i32, Option<f64>, Option<f64>)>(db)
        .unwrap();
    for event in summary_snapshots(db) {
        let mut dates = Vec::new();
        let mut participants = BTreeSet::new();
        let mut sites = BTreeMap::<i32, usize>::new();
        let mut ratings = Vec::new();
        let mut count = 0;
        for (id, site, date, white, black, white_elo, black_elo) in &rows {
            if event.id == 0 || i64::from(*id) != event.id {
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
                    .filter(|elo| *elo > 0.0),
            );
        }
        dates.sort();
        let site = sites
            .iter()
            .max_by_key(|(id, count)| (**count, std::cmp::Reverse(**id)))
            .map_or(0, |(id, _)| *id);
        let avg = (!ratings.is_empty())
            .then(|| (ratings.iter().sum::<f64>() / ratings.len() as f64).round() as i64);
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
                i64::from(site),
                count,
                participants.len() as i64,
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
fn both_summary_sources_match_the_oracle_on_edge_rows() {
    use event_summaries::{refresh_event_summaries, RowSource};

    let mut results = Vec::new();
    for source in [RowSource::IndexedDirtyEvents, RowSource::FullScan] {
        let mut db = SqliteConnection::establish(":memory:").unwrap();
        db.batch_execute(CREATE_TABLES_SQL).unwrap();
        db.batch_execute(
            "INSERT INTO Events(ID,Name) VALUES(1,'Partial'),(2,'Unknown only'),(3,'Empty'),(4,'Wide ratings'),(5,'Binary dates');
             INSERT INTO Sites(ID,Name) VALUES(1,'Low'),(2,'High');
             INSERT INTO Players(ID,Name) VALUES(1,'One'),(2,'Two'),(3,'Three');
             INSERT INTO Games(EventID,SiteID,Date,WhiteID,BlackID,WhiteElo,BlackElo) VALUES
             (1,2,'2016.08.01',1,1,2000,0),
             (2,0,NULL,0,0,0,NULL),
             (1,1,'2016.??.??',1,2,NULL,2001),
             (1,0,'????.??.??',0,3,-1,NULL),
             (0,1,'2026.01.01',1,2,3000,3000),
             (4,0,NULL,1,2,9223372036854775807,9223372036854775807),
             (5,0,'a',0,0,0.5,0.5),
             (5,0,'Z',0,0,NULL,0),
             (5,0,'ä',0,0,-1,NULL);
             UPDATE Events SET GameCount=99, PlayerCount=99, SiteID=2, StartDate='stale', EndDate='stale', AvgElo=99 WHERE ID=3;
             INSERT INTO EventSummaryDirty VALUES(0),(3);",
        )
        .unwrap();
        db.transaction::<_, Error, _>(|db| refresh_event_summaries(db, source))
            .unwrap();
        assert_event_summaries(&mut db);
        results.push(summary_snapshots(&mut db));

        // Both sources must leave non-dirty events and Unknown untouched, even
        // when the full scan encounters games belonging to those events.
        db.batch_execute(
            "UPDATE Events SET GameCount=123 WHERE ID IN (0,4);
             INSERT INTO EventSummaryDirty VALUES(0),(3);",
        )
        .unwrap();
        db.transaction::<_, Error, _>(|db| refresh_event_summaries(db, source))
            .unwrap();
        let snapshots = summary_snapshots(&mut db);
        assert_eq!(snapshots[0].game_count, 123);
        assert_eq!(snapshots[4].game_count, 123);
        assert_eq!(snapshots[3].game_count, 0);
        assert_eq!(snapshots[3].avg_elo, None);
        assert_eq!(
            diesel::select(diesel::dsl::sql::<diesel::sql_types::BigInt>(
                "(SELECT COUNT(*) FROM EventSummaryDirty)"
            ))
            .get_result::<i64>(&mut db)
            .unwrap(),
            0
        );
    }
    assert_eq!(results[0], results[1]);
}

#[test]
fn both_summary_sources_propagate_row_errors_and_preserve_dirty_summaries() {
    use event_summaries::{refresh_event_summaries, RowSource};

    for source in [RowSource::IndexedDirtyEvents, RowSource::FullScan] {
        let mut db = SqliteConnection::establish(":memory:").unwrap();
        db.batch_execute(
            "CREATE TABLE Events (
                 ID INTEGER PRIMARY KEY, StartDate TEXT, EndDate TEXT,
                 SiteID INTEGER NOT NULL DEFAULT 0, GameCount INTEGER NOT NULL DEFAULT 0,
                 PlayerCount INTEGER NOT NULL DEFAULT 0, AvgElo INTEGER
             );
             CREATE TABLE Games (
                 ID INTEGER PRIMARY KEY, EventID INTEGER NOT NULL, SiteID INTEGER,
                 Date TEXT, WhiteID INTEGER NOT NULL, BlackID INTEGER NOT NULL,
                 WhiteElo INTEGER, BlackElo INTEGER
             );
             CREATE TABLE EventSummaryDirty (ID INTEGER PRIMARY KEY);
             CREATE INDEX games_event_idx ON Games(EventID);
             INSERT INTO Events(ID,GameCount) VALUES(1,37);
             INSERT INTO EventSummaryDirty(ID) VALUES(1);
             INSERT INTO Games(ID,EventID,SiteID,WhiteID,BlackID) VALUES(1,1,NULL,0,0);",
        )
        .unwrap();

        let result = db.transaction::<_, Error, _>(|db| refresh_event_summaries(db, source));
        assert!(
            matches!(&result, Err(Error::Diesel(error)) if matches!(
                error.as_ref(), diesel::result::Error::DeserializationError(_)
            )),
            "{source:?}: expected a row deserialization error, got {result:?}"
        );
        assert_eq!(summary_snapshots(&mut db)[0].game_count, 37, "{source:?}");
        assert_eq!(
            diesel::select(diesel::dsl::sql::<diesel::sql_types::BigInt>(
                "(SELECT COUNT(*) FROM EventSummaryDirty WHERE ID = 1)"
            ))
            .get_result::<i64>(&mut db)
            .unwrap(),
            1,
            "{source:?}"
        );
    }
}

#[test]
fn production_summary_callers_choose_indexed_refresh_and_full_migration_scan() {
    use event_summaries::{take_row_source, RowSource};

    let mut db = SqliteConnection::establish(":memory:").unwrap();
    db.batch_execute(CREATE_TABLES_SQL).unwrap();
    db.batch_execute(
        "INSERT INTO Events(ID,Name) VALUES(1,'Event'); INSERT INTO Games(EventID) VALUES(1);",
    )
    .unwrap();
    take_row_source();
    db.transaction::<_, Error, _>(refresh_derived_database_data)
        .unwrap();
    assert_eq!(take_row_source(), Some(RowSource::IndexedDirtyEvents));
    assert_event_summaries(&mut db);

    #[derive(QueryableByName)]
    struct QueryPlan {
        #[diesel(sql_type = Text)]
        detail: String,
    }
    let plan = sql_query(format!(
        "EXPLAIN QUERY PLAN {}",
        RowSource::IndexedDirtyEvents.sql()
    ))
    .load::<QueryPlan>(&mut db)
    .unwrap();
    let details: Vec<_> = plan.iter().map(|step| step.detail.as_str()).collect();
    assert!(
        details
            .iter()
            .any(|detail| detail.contains("SEARCH g USING INDEX games_event_idx (EventID=?)")),
        "{details:?}"
    );
    assert!(
        !details
            .iter()
            .any(|detail| detail.starts_with("SCAN g") || detail.starts_with("SCAN Games")),
        "{details:?}"
    );

    let mut legacy = SqliteConnection::establish(":memory:").unwrap();
    legacy
        .batch_execute(&migrations::pre_event_summary_schema())
        .unwrap();
    legacy.batch_execute("INSERT INTO Info(Name,Value) VALUES('Version','2.2.0'); INSERT INTO Events(ID,Name) VALUES(1,'Event'); INSERT INTO Games(EventID) VALUES(1);")
        .unwrap();
    migrations::validate_existing_database(&mut legacy).unwrap();
    assert_eq!(take_row_source(), Some(RowSource::FullScan));
    assert_event_summaries(&mut legacy);
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
        refresh_derived_database_data(db)?;
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
        refresh_derived_database_data(db)
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
            refresh_derived_database_data(db)
        })
        .unwrap();
        assert_event_summaries(&mut db);
    }
}

#[test]
fn summary_site_prefers_frequency_over_lowest_site_id() {
    let mut db = SqliteConnection::establish(":memory:").unwrap();
    db.batch_execute(CREATE_TABLES_SQL).unwrap();
    db.batch_execute(
        "INSERT INTO Events(ID,Name) VALUES(1,'Event');
         INSERT INTO Sites(ID,Name) VALUES(1,'Low'),(2,'High');
         INSERT INTO Games(EventID,SiteID) VALUES(1,1),(1,2),(1,2);",
    )
    .unwrap();
    db.transaction::<_, Error, _>(refresh_derived_database_data)
        .unwrap();

    assert_eq!(
        events::table
            .find(1)
            .select(events::site_id)
            .first::<i32>(&mut db)
            .unwrap(),
        2
    );
    assert_event_summaries(&mut db);
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
    db.transaction::<_, Error, _>(refresh_derived_database_data)
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
fn production_read_date_sort_uses_latest_end_and_earliest_start() {
    let (_dir, app, handle, path) = blocking_database_case();
    let mut db = SqliteConnection::establish(path.to_str().unwrap()).unwrap();
    db.batch_execute(
        "INSERT INTO Events(ID,Name) VALUES(1,'A'),(2,'B'),(3,'C');
         INSERT INTO Games(EventID,Date) VALUES
         (1,'2000.01.01'),(1,'2025.01.01'),
         (2,'2024.01.01'),(2,'2024.02.01'),
         (3,'2010.01.01'),(3,'2010.01.02');",
    )
    .unwrap();
    db.transaction::<_, Error, _>(refresh_derived_database_data)
        .unwrap();
    let state = app.state::<AppState>();
    for (direction, expected) in [
        (SortDirection::Desc, vec![1, 2, 3]),
        (SortDirection::Asc, vec![1, 3, 2]),
    ] {
        let mut ids = Vec::new();
        for page in 1..=2 {
            let result = get_tournaments_blocking(
                &state.pgn_path_authority,
                &state.database_repository,
                handle.clone(),
                query(TournamentSort::Date, direction.clone(), page),
                &CancellationToken::new(),
            )
            .unwrap();
            assert_eq!(result.count, Some(3));
            ids.extend(result.data.into_iter().map(|event| event.id));
        }
        assert_eq!(ids, expected, "{direction:?}");
    }
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

/// Reuse an immutable 2.2.0 seed, but migrate a fresh disposable copy every run.
#[test]
#[ignore]
fn event_summary_migration_scale() {
    let seed = std::path::PathBuf::from(std::env::var("EVENT_SUMMARY_BENCH_SEED").unwrap());
    let parent = seed.parent().unwrap();
    std::fs::create_dir_all(parent).unwrap();
    if !seed.exists() {
        let staging = tempfile::NamedTempFile::new_in(parent).unwrap();
        {
            let mut db = SqliteConnection::establish(staging.path().to_str().unwrap()).unwrap();
            db.batch_execute(&migrations::pre_event_summary_schema())
                .unwrap();
            // Populate Games before Players so random per-game player-count index
            // writes do not dominate seed creation. Restore exact counts below.
            // Disable foreign keys only on this seed connection to allow that order.
            // It is dropped before persist, so migration uses normal enforcement.
            db.batch_execute("PRAGMA foreign_keys = OFF;").unwrap();
            db.transaction::<_, Error, _>(|db| {
                db.batch_execute(
                    "WITH RECURSIVE n(id) AS (VALUES(1) UNION ALL SELECT id+1 FROM n WHERE id<70038)
                     INSERT INTO Events(ID,Name) SELECT id, 'Event ' || id FROM n;
                     WITH RECURSIVE n(id) AS (VALUES(1) UNION ALL SELECT id+1 FROM n WHERE id<128)
                     INSERT INTO Sites(ID,Name) SELECT id, 'Site ' || id FROM n;
                     WITH RECURSIVE n(id) AS (VALUES(1) UNION ALL SELECT id+1 FROM n WHERE id<11441614)
                     INSERT INTO Games(ID,EventID,SiteID,Date,WhiteID,BlackID,WhiteElo,BlackElo)
                     SELECT id, ((id-1)/200)%70038+1, id%128+1, '2016.01.01',
                         (random() & 2147483647)%1000000+1,
                         (random() & 2147483647)%1000000+1,
                         2000+id%800, 2000+(id+1)%800 FROM n;
                     INSERT INTO Players(ID,Name,GameCount)
                     SELECT PlayerID, 'Player ' || PlayerID, COUNT(*) FROM (
                         SELECT WhiteID AS PlayerID FROM Games
                         UNION ALL SELECT BlackID AS PlayerID FROM Games WHERE BlackID != WhiteID
                     ) GROUP BY PlayerID;
                     INSERT INTO Info(Name,Value) VALUES('Version','2.2.0'),('Title','Event summary scale');
                     INSERT INTO Info(Name,Value) SELECT 'GameCount', COUNT(*) FROM Games;
                     INSERT INTO Info(Name,Value) SELECT 'PlayerCount', COUNT(*) FROM Players;
                     INSERT INTO Info(Name,Value) SELECT 'EventCount', COUNT(*) FROM Events;
                     INSERT INTO Info(Name,Value) SELECT 'SiteCount', COUNT(*) FROM Sites;",
                )?;
                Ok(())
            })
            .unwrap();
        }
        staging.persist_noclobber(&seed).unwrap();
        println!("Generated immutable 2.2.0 seed: {}", seed.display());
    }

    let copy = tempfile::Builder::new()
        .prefix("event-summary-migration-")
        .suffix(".db3")
        .tempfile_in(parent)
        .unwrap();
    std::fs::copy(&seed, copy.path()).unwrap();
    let version = |path: &std::path::Path| {
        let mut db = SqliteConnection::establish(path.to_str().unwrap()).unwrap();
        info::table
            .filter(info::name.eq("Version"))
            .select(info::value)
            .first::<Option<String>>(&mut db)
            .unwrap()
    };
    assert_eq!(version(copy.path()).as_deref(), Some("2.2.0"));
    let registry = tempfile::tempdir().unwrap();
    let (app, handle) = database_app_with_grant(
        registry.path(),
        copy.path(),
        "Event summary migration scale",
        full_database_operations(),
    );
    let state = app.state::<AppState>();
    let start = Instant::now();
    let ready = loop {
        let metadata = get_db_info_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            handle.clone(),
        )
        .unwrap();
        assert!(
            start.elapsed() < std::time::Duration::from_secs(180),
            "event_summary_migration_scale upgrade did not become ready within 180 s"
        );
        match metadata.info {
            DatabaseInfoResult::Ready(info) => break info,
            DatabaseInfoResult::Upgrading { .. } | DatabaseInfoResult::Busy { .. } => {
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            DatabaseInfoResult::UpgradeFailed { message, .. } => {
                panic!("event_summary_migration_scale upgrade failed: {message}");
            }
        }
    };
    let elapsed = start.elapsed();
    println!("event_summary_migration_scale upgrade to ready: {elapsed:?}");
    assert_eq!(version(copy.path()).as_deref(), Some("2.3.0"));
    assert_eq!(ready.game_count, 11_441_614);
    assert_eq!(ready.event_count, 70_039);
    drop(app);
    let copy_path = copy.path().to_path_buf();
    copy.close().unwrap();
    for suffix in ["-wal", "-shm"] {
        let mut sidecar = copy_path.as_os_str().to_os_string();
        sidecar.push(suffix);
        if let Err(error) = std::fs::remove_file(&sidecar) {
            assert_eq!(
                error.kind(),
                std::io::ErrorKind::NotFound,
                "failed to remove {sidecar:?}: {error}"
            );
        }
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
