//! Player statistics: the `get_players_game_info` command and its accumulators.

use super::*;

#[derive(Debug, Clone, Serialize, Type, Default)]
pub struct PlayerGameInfo {
    pub site_stats_data: Vec<SiteStatsData>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, Type)]
#[repr(u8)] // Ensure minimal memory usage (as u8)
pub enum GameOutcome {
    #[default]
    Won = 0,
    Drawn = 1,
    Lost = 2,
}

impl GameOutcome {
    pub fn from_str(result_str: &str, is_white: bool) -> Option<Self> {
        match result_str {
            "1-0" => Some(if is_white {
                GameOutcome::Won
            } else {
                GameOutcome::Lost
            }),
            "1/2-1/2" => Some(GameOutcome::Drawn),
            "0-1" => Some(if is_white {
                GameOutcome::Lost
            } else {
                GameOutcome::Won
            }),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Type, Default)]
pub struct SiteStatsData {
    pub site: String,
    pub player: String,
    pub daily: Vec<DailyStatsData>,
    pub openings: Vec<OpeningStatsData>,
    pub colors: Vec<ColorStatsData>,
    pub latest: Vec<LatestRatingData>,
}

#[derive(Debug, Clone, Serialize, Type, Default)]
pub struct DailyStatsData {
    pub date: String,
    pub time_control: String,
    pub won: u32,
    pub drawn: u32,
    pub lost: u32,
    /// The player's highest positive rating among that day's games; `None` when every game of
    /// the day is unrated (rating absent, or stored as 0 from `"-"`/`"0"`).
    pub max_player_elo: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Type, Default)]
pub struct OpeningStatsData {
    pub time_control: String,
    pub is_player_white: bool,
    pub opening: String,
    pub won: u32,
    pub drawn: u32,
    pub lost: u32,
}

/// `rated_won`, `rated_drawn` and `rated_lost` count only games whose opponent rating is
/// present and positive. `opponent_elo_sum` sums those ratings as f64, which exports as a
/// TS number, saturating at JavaScript's maximum safe integer (2^53 - 1) to avoid overflow
/// and inexact integer sums.
#[derive(Debug, Clone, Serialize, Type, Default)]
pub struct ColorStatsData {
    pub time_control: String,
    pub is_player_white: bool,
    pub won: u32,
    pub drawn: u32,
    pub lost: u32,
    pub rated_won: u32,
    pub rated_drawn: u32,
    pub rated_lost: u32,
    pub opponent_elo_sum: f64,
}

#[derive(Debug, Clone, Serialize, Type, Default)]
pub struct LatestRatingData {
    pub time_control: String,
    pub date: String,
    pub time: Option<String>,
    pub game_id: i32,
    pub player_elo: i32,
}

impl LatestRatingData {
    fn chronology(&self) -> (&str, &Option<String>, i32) {
        (&self.date, &self.time, self.game_id)
    }
}

#[tauri::command]
#[specta::specta]
pub async fn get_players_game_info(
    progress_id: String,
    file: DatabaseHandle,
    id: i32,
    ticket: Option<String>,
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<PlayerGameInfo, Error> {
    let operation = crate::native_read_operation(ticket, &window, &state, "get_players_game_info")?;
    let cancellation = operation.token();
    let progress = JobProgress::best_effort(app.clone(), progress_id, "get_players_game_info");
    let authority = state.pgn_path_authority.clone();
    let repository = Arc::clone(&state.database_repository);
    let lease = progress.as_ref().map(JobProgress::lease);
    let worker_app = app.clone();
    crate::infra::operations::run_native_operation(operation, "get_players_game_info", async move {
        BLOCKING_GATEWAY
            .spawn_cancellable(cancellation, move |token| {
                let result = get_players_game_info_blocking(
                    &authority,
                    &repository,
                    file,
                    id,
                    (worker_app, lease),
                    token,
                    #[cfg(test)]
                    None,
                );
                complete_preserving_result(result, |state| {
                    if let Some(progress) = &progress {
                        progress.complete(state);
                    }
                })
            })
            .await
    })
    .await
}

pub(super) fn get_players_game_info_blocking<R: tauri::Runtime>(
    authority: &crate::infra::path_authority::SharedPathAuthority,
    repository: &DatabaseRepository,
    file: DatabaseHandle,
    id: i32,
    (app, lease): (tauri::AppHandle<R>, Option<ProgressLease>),
    cancellation: &CancellationToken,
    #[cfg(test)] progress_update: Option<&ProgressUpdateHook<'_>>,
) -> Result<PlayerGameInfo, Error> {
    cancellation_check(cancellation)?;
    let target = resolve_database(authority, &file, PathOperation::DatabaseRead)?;

    let mut database_connection =
        get_db_or_create(repository, &target, Some(cancellation), authority, &file)?;
    let db = &mut *database_connection;
    linked_collections::read_snapshot(db, authority, &file, |db| {
        let timer = Instant::now();

        let base_query = games::table
            .inner_join(sites::table.on(games::site_id.eq(sites::id)))
            .inner_join(players::table.on(players::id.eq(id)))
            .filter(games::white_id.eq(id).or(games::black_id.eq(id)));

        let progress_error_diagnosed = std::sync::atomic::AtomicBool::new(false);
        let emit_progress = |kept_rows, total_rows| {
            if let Some(lease) = &lease {
                let percent =
                    (player_statistics_progress_fraction(kept_rows, total_rows) * 100_f64) as f32;
                let report_progress = || {
                    update_progress_with_state(
                        &app.state::<AppState>().progress_state,
                        &app,
                        lease,
                        percent,
                        ProgressState::Running,
                    )
                };
                #[cfg(test)]
                let progress_result = progress_update
                    .and_then(|update| update(lease, percent))
                    .unwrap_or_else(report_progress);
                #[cfg(not(test))]
                let progress_result = report_progress();
                handle_running_progress_result(
                    progress_result,
                    "get_players_game_info",
                    lease,
                    &progress_error_diagnosed,
                    None,
                )?;
            }
            Ok::<(), Error>(())
        };

        let mut accumulator = PlayerStatisticsAccumulator::default();
        let mut kept_rows = 0usize;
        let total_rows = sqlite_cancellation::with_sqlite_cancellation(cancellation, || {
            let total_rows = base_query.count().get_result::<i64>(db)?;
            let sql_query = base_query.select((
                games::white_id,
                games::black_id,
                games::result,
                games::date,
                games::moves,
                games::white_elo,
                games::black_elo,
                games::time_control,
                sites::name,
                players::name,
                games::id,
                games::time,
                games::fen,
            ));
            let rows = sql_query.load_iter::<PlayerStatisticsRow, DefaultLoadingMode>(db)?;
            process_player_statistics_batches(
                rows,
                PLAYER_STATISTICS_BATCH_ROW_BYTE_BUDGET,
                PLAYER_STATISTICS_BATCH_ROW_LIMIT,
                cancellation,
                |batch| {
                    // Per-job child tokens: the shared token's mutex would serialise the
                    // per-move checks of every worker (see `search_position_blocking`).
                    let evaluated = batch
                        .par_iter()
                        .map_init(
                            || cancellation.child_token(),
                            |row_cancellation, row| {
                                evaluate_player_statistics_row(row, id, row_cancellation)
                            },
                        )
                        .collect::<Result<Vec<_>, Error>>()?;

                    for row in evaluated.into_iter().flatten() {
                        cancellation_check(cancellation)?;
                        accumulator.add(row);
                        kept_rows = kept_rows.saturating_add(1);
                        if (kept_rows - 1).is_multiple_of(PLAYER_STATISTICS_PROGRESS_INTERVAL) {
                            emit_progress(kept_rows, total_rows)?;
                        }
                    }

                    Ok(())
                },
            )?;
            Ok::<i64, Error>(total_rows)
        })?;

        cancellation_check(cancellation)?;
        if kept_rows > 0 {
            emit_progress(kept_rows, total_rows)?;
        }

        let game_info = accumulator.into_player_game_info();
        cancellation_check(cancellation)?;

        println!(
            "get_players_game_info {:?}: {:?}",
            target.path(),
            timer.elapsed()
        );

        Ok(game_info)
    })
}

#[derive(Queryable)]
pub(super) struct PlayerStatisticsRow {
    pub(super) white_id: i32,
    pub(super) black_id: i32,
    pub(super) outcome: Option<String>,
    pub(super) date: Option<String>,
    pub(super) moves: Vec<u8>,
    pub(super) white_elo: Option<i32>,
    pub(super) black_elo: Option<i32>,
    pub(super) time_control: Option<String>,
    pub(super) site: Option<String>,
    pub(super) player: Option<String>,
    pub(super) game_id: i32,
    pub(super) time: Option<String>,
    /// The stored starting position; `None` is the standard start.
    pub(super) fen: Option<String>,
}

impl PlayerStatisticsRow {
    pub(super) fn owned_heap_bytes(&self) -> usize {
        self.moves
            .len()
            .saturating_add(self.outcome.as_ref().map_or(0, String::len))
            .saturating_add(self.date.as_ref().map_or(0, String::len))
            .saturating_add(self.time.as_ref().map_or(0, String::len))
            .saturating_add(self.time_control.as_ref().map_or(0, String::len))
            .saturating_add(self.site.as_ref().map_or(0, String::len))
            .saturating_add(self.player.as_ref().map_or(0, String::len))
            .saturating_add(self.fen.as_ref().map_or(0, String::len))
    }
}

pub(super) struct EvaluatedPlayerStatisticsRow {
    site: String,
    player: String,
    date: String,
    is_player_white: bool,
    /// Positive ratings only: absent and 0 (the importer's spelling of `"-"`/`"0"`) are unrated.
    player_elo: Option<i32>,
    result: GameOutcome,
    time_control: String,
    opening: String,
    opponent_elo: Option<i32>,
    game_id: i32,
    time: Option<String>,
}

#[derive(Default)]
pub(super) struct PlayerStatisticsOutcomeCounts {
    won: u32,
    drawn: u32,
    lost: u32,
}

impl PlayerStatisticsOutcomeCounts {
    fn add(&mut self, result: &GameOutcome) {
        match result {
            GameOutcome::Won => self.won = self.won.saturating_add(1),
            GameOutcome::Drawn => self.drawn = self.drawn.saturating_add(1),
            GameOutcome::Lost => self.lost = self.lost.saturating_add(1),
        }
    }
}

#[derive(Default)]
pub(super) struct PlayerStatisticsDailyAccumulator {
    outcomes: PlayerStatisticsOutcomeCounts,
    max_player_elo: Option<i32>,
}

#[derive(Default)]
pub(super) struct PlayerStatisticsColorAccumulator {
    outcomes: PlayerStatisticsOutcomeCounts,
    rated_outcomes: PlayerStatisticsOutcomeCounts,
    opponent_elo_sum: f64,
}

/// The result holds one record per distinct (site, player, time_control, date) and per distinct
/// (site, player, time_control, colour, opening), plus per-colour totals and the latest rating
/// per time control. Apart from the Lichess URL normalisation,
/// site and time_control are kept verbatim, so a database whose games carry per-game Site or
/// TimeControl strings yields one small record per game. Move blobs are never retained.
#[derive(Default)]
pub(super) struct PlayerStatisticsAccumulator {
    daily: HashMap<(String, String, String, String), PlayerStatisticsDailyAccumulator>,
    openings: HashMap<(String, String, String, bool, String), PlayerStatisticsOutcomeCounts>,
    colors: HashMap<(String, String, String, bool), PlayerStatisticsColorAccumulator>,
    latest: HashMap<(String, String, String), LatestRatingData>,
}

impl PlayerStatisticsAccumulator {
    fn add(&mut self, row: EvaluatedPlayerStatisticsRow) {
        let EvaluatedPlayerStatisticsRow {
            site,
            player,
            date,
            is_player_white,
            player_elo,
            result,
            time_control,
            opening,
            opponent_elo,
            game_id,
            time,
        } = row;
        let date = pgn_date::canonical(&date).into_owned();

        // Only rated games with complete, valid calendar dates participate in chronological
        // rating selection.
        let rating_on_complete_date = player_elo.filter(|_| {
            date.len() == 10
                && date.bytes().enumerate().all(|(index, byte)| {
                    if index == 4 || index == 7 {
                        byte == b'.'
                    } else {
                        byte.is_ascii_digit()
                    }
                })
                && NaiveDate::parse_from_str(&date, "%Y.%m.%d").is_ok()
        });
        if let Some(player_elo) = rating_on_complete_date {
            let candidate = LatestRatingData {
                time_control: time_control.clone(),
                date: date.clone(),
                time,
                game_id,
                player_elo,
            };
            let latest = self
                .latest
                .entry((site.clone(), player.clone(), time_control.clone()))
                .or_insert_with(|| candidate.clone());
            if candidate.chronology() > latest.chronology() {
                *latest = candidate;
            }
        }

        let color = self
            .colors
            .entry((
                site.clone(),
                player.clone(),
                time_control.clone(),
                is_player_white,
            ))
            .or_default();
        color.outcomes.add(&result);
        if let Some(opponent_elo) = opponent_elo.filter(|rating| *rating > 0) {
            color.rated_outcomes.add(&result);
            color.opponent_elo_sum =
                (color.opponent_elo_sum + f64::from(opponent_elo)).min(9_007_199_254_740_991.0);
        }

        let daily = self
            .daily
            .entry((site.clone(), player.clone(), time_control.clone(), date))
            .or_default();
        daily.outcomes.add(&result);
        daily.max_player_elo = daily.max_player_elo.max(player_elo);

        self.openings
            .entry((site, player, time_control, is_player_white, opening))
            .or_default()
            .add(&result);
    }

    fn into_player_game_info(self) -> PlayerGameInfo {
        let mut grouped: HashMap<(String, String), SiteStatsData> = HashMap::new();

        for ((site, player, time_control, date), daily) in self.daily {
            let group = player_statistics_site_group(&mut grouped, &site, &player);
            group.daily.push(DailyStatsData {
                date,
                time_control,
                won: daily.outcomes.won,
                drawn: daily.outcomes.drawn,
                lost: daily.outcomes.lost,
                max_player_elo: daily.max_player_elo,
            });
        }

        for ((site, player, time_control, is_player_white, opening), outcomes) in self.openings {
            let group = player_statistics_site_group(&mut grouped, &site, &player);
            group.openings.push(OpeningStatsData {
                time_control,
                is_player_white,
                opening,
                won: outcomes.won,
                drawn: outcomes.drawn,
                lost: outcomes.lost,
            });
        }

        for ((site, player, time_control, is_player_white), color) in self.colors {
            let group = player_statistics_site_group(&mut grouped, &site, &player);
            group.colors.push(ColorStatsData {
                time_control,
                is_player_white,
                won: color.outcomes.won,
                drawn: color.outcomes.drawn,
                lost: color.outcomes.lost,
                rated_won: color.rated_outcomes.won,
                rated_drawn: color.rated_outcomes.drawn,
                rated_lost: color.rated_outcomes.lost,
                opponent_elo_sum: color.opponent_elo_sum,
            });
        }
        for ((site, player, _), latest) in self.latest {
            player_statistics_site_group(&mut grouped, &site, &player)
                .latest
                .push(latest);
        }

        let mut site_stats_data: Vec<_> = grouped.into_values().collect();
        for group in &mut site_stats_data {
            group.daily.sort_unstable_by(|left, right| {
                left.time_control
                    .cmp(&right.time_control)
                    .then_with(|| left.date.cmp(&right.date))
            });
            group.openings.sort_unstable_by(|left, right| {
                left.time_control
                    .cmp(&right.time_control)
                    .then_with(|| left.is_player_white.cmp(&right.is_player_white))
                    .then_with(|| left.opening.cmp(&right.opening))
            });
            group.colors.sort_unstable_by(|left, right| {
                left.time_control
                    .cmp(&right.time_control)
                    .then_with(|| left.is_player_white.cmp(&right.is_player_white))
            });
            group
                .latest
                .sort_unstable_by(|left, right| left.time_control.cmp(&right.time_control));
        }
        site_stats_data.sort_unstable_by(|left, right| {
            left.site
                .cmp(&right.site)
                .then_with(|| left.player.cmp(&right.player))
        });

        PlayerGameInfo { site_stats_data }
    }
}

pub(super) fn player_statistics_site_group<'a>(
    grouped: &'a mut HashMap<(String, String), SiteStatsData>,
    site: &str,
    player: &str,
) -> &'a mut SiteStatsData {
    grouped
        .entry((site.to_string(), player.to_string()))
        .or_insert_with(|| SiteStatsData {
            site: site.to_string(),
            player: player.to_string(),
            ..SiteStatsData::default()
        })
}

pub(super) fn evaluate_player_statistics_row(
    row: &PlayerStatisticsRow,
    id: i32,
    cancellation: &CancellationToken,
) -> Result<Option<EvaluatedPlayerStatisticsRow>, Error> {
    cancellation_check(cancellation)?;
    let is_white = row.white_id == id;
    let is_black = row.black_id == id;
    if !is_white && !is_black {
        return Ok(None);
    }

    let Some(player) = row.player.clone() else {
        return Ok(None);
    };
    // A game without a Date tag still counts in the results; it is grouped under the PGN
    // unknown date, which never enters the time axis or rating selection (d-20261107-04).
    let date = row
        .date
        .clone()
        .unwrap_or_else(|| GameSignature::ABSENT_DATE.to_string());
    let Some(result) = row
        .outcome
        .as_deref()
        .and_then(|outcome| GameOutcome::from_str(outcome, is_white))
    else {
        return Ok(None);
    };
    // The player's own rating is needed only for the rating series, never for eligibility.
    let player_elo = if is_white {
        row.white_elo
    } else {
        row.black_elo
    }
    .filter(|elo| *elo > 0);
    let Some(site) = row.site.as_deref().map(|site| {
        if site.starts_with("https://lichess.org/") {
            "Lichess".to_string()
        } else {
            site.to_string()
        }
    }) else {
        return Ok(None);
    };

    let move_bytes = match try_iter_mainline_move_bytes_cancellable(&row.moves, cancellation) {
        Ok(move_bytes) => move_bytes,
        Err(Error::Cancellation) => return Err(Error::Cancellation),
        Err(_) => return Ok(None),
    };
    // Moves are encoded against the game's own start, so they are replayed from it. A game
    // from a custom position or Chess960 counts in the results like any other; its opening
    // is whatever a position after one of its moves matches, often none.
    // An unreadable stored FEN is corrupt data, like an invalid move stream, and drops the row.
    let Ok(mut chess) = database_start_position(row.game_id, row.fen.as_deref()) else {
        return Ok(None);
    };
    let mut setups = vec![];
    for byte in move_bytes.take(OPENING_STATISTICS_PLY_LIMIT) {
        cancellation_check(cancellation)?;
        let Some(m) = decode_move(byte, &chess) else {
            break;
        };
        chess.play_unchecked(&m);
        setups.push(chess.clone().into_setup(EnPassantMode::Legal));
    }

    setups.reverse();
    let opening = setups
        .iter()
        .find_map(|setup| get_opening_from_setup(setup.clone()).ok())
        .unwrap_or_default();

    Ok(Some(EvaluatedPlayerStatisticsRow {
        site,
        player,
        date,
        is_player_white: is_white,
        player_elo,
        result,
        time_control: row.time_control.clone().unwrap_or_default(),
        opening,
        opponent_elo: if is_white {
            row.black_elo
        } else {
            row.white_elo
        },
        game_id: row.game_id,
        time: row.time.clone(),
    }))
}

pub(super) fn next_player_statistics_batch<I>(
    rows: &mut I,
    pending: &mut Option<PlayerStatisticsRow>,
    row_byte_budget: usize,
    row_count_limit: usize,
) -> Result<Option<Vec<PlayerStatisticsRow>>, Error>
where
    I: Iterator<Item = diesel::QueryResult<PlayerStatisticsRow>>,
{
    let row_count_limit = row_count_limit.max(1);
    let mut batch = Vec::with_capacity(row_count_limit.min(PLAYER_STATISTICS_BATCH_ROW_LIMIT));
    let mut row_bytes = 0usize;

    loop {
        let row = match pending.take() {
            Some(row) => row,
            None => match rows.next() {
                Some(row) => row.map_err(Error::from)?,
                None => break,
            },
        };
        let row_heap_bytes = row.owned_heap_bytes();

        if !batch.is_empty()
            && (batch.len() >= row_count_limit
                || row_bytes.saturating_add(row_heap_bytes) > row_byte_budget)
        {
            *pending = Some(row);
            break;
        }

        row_bytes = row_bytes.saturating_add(row_heap_bytes);
        batch.push(row);
        if row_heap_bytes > row_byte_budget
            || row_bytes >= row_byte_budget
            || batch.len() >= row_count_limit
        {
            break;
        }
    }

    if batch.is_empty() {
        Ok(None)
    } else {
        Ok(Some(batch))
    }
}

pub(super) fn process_player_statistics_batches<I, F>(
    rows: I,
    row_byte_budget: usize,
    row_count_limit: usize,
    cancellation: &CancellationToken,
    mut process_batch: F,
) -> Result<(), Error>
where
    I: Iterator<Item = diesel::QueryResult<PlayerStatisticsRow>>,
    F: FnMut(&[PlayerStatisticsRow]) -> Result<(), Error>,
{
    let mut rows = rows.fuse();
    let mut pending = None;
    loop {
        cancellation_check(cancellation)?;
        let Some(batch) = next_player_statistics_batch(
            &mut rows,
            &mut pending,
            row_byte_budget,
            row_count_limit,
        )?
        else {
            break;
        };
        process_batch(&batch)?;
    }
    Ok(())
}

pub(super) fn player_statistics_progress_fraction(kept_rows: usize, total_rows: i64) -> f64 {
    if total_rows <= 0 {
        return 0.0;
    }
    (kept_rows as f64 / total_rows as f64).clamp(0.0, 1.0)
}
