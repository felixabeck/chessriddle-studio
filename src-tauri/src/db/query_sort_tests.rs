use super::*;
use diesel::connection::SimpleConnection;
use tauri::Manager;

fn run_game_query(
    app: &tauri::AppHandle<tauri::test::MockRuntime>,
    handle: &DatabaseHandle,
    query: GameQuery,
) -> (Option<i32>, Vec<i32>) {
    let state = app.state::<AppState>();
    let response = get_games_blocking(
        &state.pgn_path_authority,
        &state.database_repository,
        handle.clone(),
        query,
        &CancellationToken::new(),
    )
    .unwrap();
    (
        response.count,
        response.data.into_iter().map(|game| game.id).collect(),
    )
}

fn run_player_query(
    app: &tauri::AppHandle<tauri::test::MockRuntime>,
    handle: &DatabaseHandle,
    sort: PlayerSort,
    direction: SortDirection,
    range: Option<(i32, i32)>,
    page: Option<i32>,
    page_size: Option<i32>,
) -> (Option<i32>, Vec<i32>) {
    let state = app.state::<AppState>();
    let response = get_players_blocking(
        &state.pgn_path_authority,
        &state.database_repository,
        handle.clone(),
        PlayerQuery {
            options: QueryOptions {
                skip_count: false,
                page,
                page_size,
                sort,
                direction,
            },
            name: None,
            name_match: None,
            range,
        },
        &CancellationToken::new(),
    )
    .unwrap();
    (
        response.count,
        response.data.into_iter().map(|player| player.id).collect(),
    )
}

fn check_sort_ties_and_pages(
    label: &str,
    expected_asc: &[i32],
    expected_desc: &[i32],
    mut query_ids: impl FnMut(SortDirection, Option<i32>, Option<i32>) -> (Option<i32>, Vec<i32>),
) -> Vec<String> {
    let page_size = 2;
    let mut failures = Vec::new();
    for (direction, expected) in [
        (SortDirection::Asc, expected_asc),
        (SortDirection::Desc, expected_desc),
    ] {
        let (count, unpaged_ids) = query_ids(direction.clone(), None, None);
        if count != Some(expected.len() as i32) {
            failures.push(format!(
                "{label} {direction:?}: expected count {:?}, got {count:?}",
                Some(expected.len() as i32)
            ));
        }
        if unpaged_ids != expected {
            failures.push(format!(
                "{label} {direction:?}: expected unpaged {expected:?}, got {unpaged_ids:?}"
            ));
        }

        let page_count = expected.len().div_ceil(page_size as usize) as i32;
        let mut paged_ids = Vec::new();
        for page in 1..=page_count {
            let (page_total, ids) = query_ids(direction.clone(), Some(page), Some(page_size));
            if page_total != Some(expected.len() as i32) {
                failures.push(format!(
                    "{label} {direction:?} page {page}: expected count {:?}, got {page_total:?}",
                    Some(expected.len() as i32)
                ));
            }
            paged_ids.extend(ids);
        }
        if paged_ids != unpaged_ids {
            failures.push(format!(
                "{label} {direction:?}: paged {paged_ids:?} != unpaged {unpaged_ids:?}"
            ));
        }

        let (_, past_end_ids) = query_ids(direction.clone(), Some(page_count + 1), Some(page_size));
        if !past_end_ids.is_empty() {
            failures.push(format!(
                "{label} {direction:?}: past-end page not empty: {past_end_ids:?}"
            ));
        }
    }
    failures
}

#[test]
fn game_sorts_break_ties_by_id_in_sort_direction_across_pages() {
    struct GameSortCase {
        sort: GameSort,
        driver_index: &'static str,
        seed_sql: &'static str,
        range1: Option<(i32, i32)>,
        range2: Option<(i32, i32)>,
    }

    // Each case pairs an unfiltered scan (ascending ID order, catching a missing
    // Desc tiebreak) with a range-filtered scan over an indexed column whose values
    // decrease as ID increases (descending ID order, catching a missing Asc tiebreak).
    let cases = [
        GameSortCase {
            sort: GameSort::Date,
            driver_index: "CREATE INDEX games_white_elo_idx ON Games(WhiteElo);",
            seed_sql: "INSERT INTO Games(ID, WhiteMaterial, BlackMaterial, Moves, WhiteElo, Date, UTCTime) VALUES
                (10, 0, 0, X'', 2600, NULL, NULL),
                (11, 0, 0, X'', 2500, '2026.01.01', '12:00:00'),
                (12, 0, 0, X'', 2400, '2026.01.01', '12:00:00'),
                (13, 0, 0, X'', 2300, '2026.01.01', '12:00:00'),
                (14, 0, 0, X'', 2200, '2026.01.02', '08:00:00'),
                (15, 0, 0, X'', 2100, NULL, NULL);",
            range1: Some((2000, 3000)),
            range2: None,
        },
        GameSortCase {
            sort: GameSort::WhiteElo,
            driver_index: "CREATE INDEX games_black_elo_idx ON Games(BlackElo);",
            seed_sql: "INSERT INTO Games(ID, WhiteMaterial, BlackMaterial, Moves, BlackElo, WhiteElo) VALUES
                (10, 0, 0, X'', 2600, NULL),
                (11, 0, 0, X'', 2500, 2500),
                (12, 0, 0, X'', 2400, 2500),
                (13, 0, 0, X'', 2300, 2500),
                (14, 0, 0, X'', 2200, 2700),
                (15, 0, 0, X'', 2100, NULL);",
            range1: None,
            range2: Some((2000, 3000)),
        },
        GameSortCase {
            sort: GameSort::BlackElo,
            driver_index: "CREATE INDEX games_white_elo_idx ON Games(WhiteElo);",
            seed_sql: "INSERT INTO Games(ID, WhiteMaterial, BlackMaterial, Moves, WhiteElo, BlackElo) VALUES
                (10, 0, 0, X'', 2600, NULL),
                (11, 0, 0, X'', 2500, 2500),
                (12, 0, 0, X'', 2400, 2500),
                (13, 0, 0, X'', 2300, 2500),
                (14, 0, 0, X'', 2200, 2700),
                (15, 0, 0, X'', 2100, NULL);",
            range1: Some((2000, 3000)),
            range2: None,
        },
        GameSortCase {
            sort: GameSort::PlyCount,
            driver_index: "CREATE INDEX games_white_elo_idx ON Games(WhiteElo);",
            seed_sql: "INSERT INTO Games(ID, WhiteMaterial, BlackMaterial, Moves, WhiteElo, PlyCount) VALUES
                (10, 0, 0, X'', 2600, NULL),
                (11, 0, 0, X'', 2500, 40),
                (12, 0, 0, X'', 2400, 40),
                (13, 0, 0, X'', 2300, 40),
                (14, 0, 0, X'', 2200, 80),
                (15, 0, 0, X'', 2100, NULL);",
            range1: Some((2000, 3000)),
            range2: None,
        },
        GameSortCase {
            sort: GameSort::Round,
            driver_index: "CREATE INDEX games_white_elo_idx ON Games(WhiteElo);",
            seed_sql: "INSERT INTO Games(ID, WhiteMaterial, BlackMaterial, Moves, WhiteElo, Round) VALUES
                (10, 0, 0, X'', 2600, NULL),
                (11, 0, 0, X'', 2500, '1'),
                (12, 0, 0, X'', 2400, '1'),
                (13, 0, 0, X'', 2300, '1'),
                (14, 0, 0, X'', 2200, '2'),
                (15, 0, 0, X'', 2100, NULL);",
            range1: Some((2000, 3000)),
            range2: None,
        },
    ];

    let mut failures = Vec::new();
    for case in cases {
        let (_dir, app, handle, path) = blocking_database_case();
        let mut db = SqliteConnection::establish(path.to_str().unwrap()).unwrap();
        db.batch_execute(case.driver_index).unwrap();
        db.batch_execute(case.seed_sql).unwrap();
        drop(db);

        for (filter_label, sides, range1, range2) in [
            ("unfiltered", None, None, None),
            (
                "reverse-scan",
                Some(Sides::WhiteBlack),
                case.range1,
                case.range2,
            ),
        ] {
            failures.extend(check_sort_ties_and_pages(
                &format!("{:?} ({filter_label})", case.sort),
                &[10, 15, 11, 12, 13, 14],
                &[14, 13, 12, 11, 15, 10],
                |direction, page, page_size| {
                    run_game_query(
                        &app,
                        &handle,
                        GameQuery {
                            options: Some(QueryOptions {
                                skip_count: false,
                                page,
                                page_size,
                                sort: case.sort.clone(),
                                direction,
                            }),
                            sides: sides.clone(),
                            range1,
                            range2,
                            ..GameQuery::new()
                        },
                    )
                },
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "tiebreak failures:\n{}",
        failures.join("\n")
    );
}

#[test]
fn player_name_sort_breaks_ties_by_id_in_sort_direction_across_pages() {
    let (_dir, app, handle, path) = blocking_database_case();
    let mut db = SqliteConnection::establish(path.to_str().unwrap()).unwrap();
    // Players.Name is TEXT UNIQUE (nullable), so multiple NULL-named rows tie.
    // Non-monotonic Elo values indexed by test_players_elo_idx make the range
    // query scan the tied NULL rows in [12, 10, 11] order (neither ascending
    // nor descending ID), so reverting either direction's tiebreak fails.
    db.batch_execute(
        "CREATE INDEX test_players_elo_idx ON Players(Elo);
         INSERT INTO Players(ID, Name, Elo) VALUES
            (10, NULL, 2200),
            (11, NULL, 2400),
            (12, NULL, 2100),
            (13, 'Alpha', 2150),
            (14, 'Zulu', 2250);",
    )
    .unwrap();
    drop(db);

    let mut failures = Vec::new();
    for range in [None, Some((2000, 2500))] {
        failures.extend(check_sort_ties_and_pages(
            &format!("PlayerSort::Name range={range:?}"),
            &[10, 11, 12, 13, 14],
            &[14, 13, 12, 11, 10],
            |direction, page, page_size| {
                run_player_query(
                    &app,
                    &handle,
                    PlayerSort::Name,
                    direction,
                    range,
                    page,
                    page_size,
                )
            },
        ));
    }
    assert!(
        failures.is_empty(),
        "tiebreak failures:\n{}",
        failures.join("\n")
    );
}

#[test]
fn player_elo_sort_breaks_ties_by_id_in_sort_direction_across_pages() {
    let (_dir, app, handle, path) = blocking_database_case();
    let mut db = SqliteConnection::establish(path.to_str().unwrap()).unwrap();
    // An (Elo ASC, ID DESC) index causes an untied `ORDER BY Elo ASC` to walk
    // tied rows in descending ID order, and an untied `ORDER BY Elo DESC` to walk
    // them in ascending ID order, so reverting either direction's tiebreak fails.
    db.batch_execute(
        "CREATE INDEX test_players_elo_id_desc ON Players(Elo ASC, ID DESC);
         INSERT INTO Players(ID, Name, Elo) VALUES
            (10, 'P10', NULL),
            (11, 'P11', 2500),
            (12, 'P12', 2500),
            (13, 'P13', 2500),
            (14, 'P14', 2700),
            (15, 'P15', NULL);",
    )
    .unwrap();
    drop(db);

    let failures = check_sort_ties_and_pages(
        "PlayerSort::Elo",
        &[10, 15, 11, 12, 13, 14],
        &[14, 13, 12, 11, 15, 10],
        |direction, page, page_size| {
            run_player_query(
                &app,
                &handle,
                PlayerSort::Elo,
                direction,
                None,
                page,
                page_size,
            )
        },
    );
    assert!(
        failures.is_empty(),
        "tiebreak failures:\n{}",
        failures.join("\n")
    );
}

#[cfg(unix)]
#[test]
fn game_date_sort_query_plan_uses_date_time_index_without_temp_btree() {
    #[derive(QueryableByName)]
    struct QueryPlanRow {
        #[diesel(sql_type = Text)]
        detail: String,
    }

    let (_dir, app, handle, path) = blocking_database_case();
    let mut db = SqliteConnection::establish(path.to_str().unwrap()).unwrap();
    create_required_indexes(&mut db).unwrap();
    db.batch_execute(
        "INSERT INTO Games(ID, WhiteMaterial, BlackMaterial, Moves, Date, UTCTime) VALUES
            (10, 0, 0, X'', '2026.01.01', '12:00:00'),
            (11, 0, 0, X'', '2026.01.01', '12:00:00'),
            (12, 0, 0, X'', '2026.01.02', '08:00:00');",
    )
    .unwrap();

    for direction in [SortDirection::Asc, SortDirection::Desc] {
        run_game_query(
            &app,
            &handle,
            GameQuery {
                options: Some(QueryOptions {
                    skip_count: false,
                    page: Some(1),
                    page_size: Some(25),
                    sort: GameSort::Date,
                    direction: direction.clone(),
                }),
                ..GameQuery::new()
            },
        );
        let sql = queries::take_last_game_page_sql().unwrap();
        let sql = sql
            .split(" -- binds")
            .next()
            .unwrap()
            .replace("LIMIT ? OFFSET ?", "LIMIT 25 OFFSET 0");
        let details: Vec<String> = sql_query(format!("EXPLAIN QUERY PLAN {sql}"))
            .load::<QueryPlanRow>(&mut db)
            .unwrap()
            .into_iter()
            .map(|row| row.detail)
            .collect();
        assert!(
            details
                .iter()
                .any(|detail| detail.contains("games_date_time_idx")),
            "expected games_date_time_idx for Date {direction:?}, got: {details:?}"
        );
        assert!(
            !details
                .iter()
                .any(|detail| detail.contains("USE TEMP B-TREE")),
            "unexpected temp B-tree sort for Date {direction:?}, got: {details:?}"
        );
    }
}
