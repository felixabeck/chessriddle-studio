use super::*;
use diesel::sql_types::{BigInt, Double};
use std::collections::HashSet;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum RowSource {
    IndexedDirtyEvents,
    FullScan,
}

impl RowSource {
    pub(super) fn sql(self) -> &'static str {
        match self {
            Self::IndexedDirtyEvents => {
                "SELECT g.EventID, g.SiteID, g.Date, g.WhiteID, g.BlackID, g.WhiteElo, g.BlackElo
                 FROM EventSummaryDirty d
                 CROSS JOIN Games g INDEXED BY games_event_idx ON g.EventID = d.ID
                 WHERE d.ID != 0"
            }
            Self::FullScan => {
                "SELECT EventID, SiteID, Date, WhiteID, BlackID, WhiteElo, BlackElo
                 FROM Games NOT INDEXED ORDER BY rowid"
            }
        }
    }
}

#[cfg(test)]
thread_local! {
    static LAST_ROW_SOURCE: std::cell::Cell<Option<RowSource>> = const { std::cell::Cell::new(None) };
    static REFRESH_COUNT: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

#[cfg(test)]
pub(super) fn take_row_source() -> Option<RowSource> {
    LAST_ROW_SOURCE.with(|source| source.take())
}

#[cfg(test)]
pub(super) fn take_refresh_count() -> usize {
    REFRESH_COUNT.with(|count| count.replace(0))
}

#[derive(QueryableByName)]
struct DirtyEvent {
    #[diesel(sql_type = BigInt, column_name = ID)]
    id: i64,
}

#[derive(QueryableByName)]
struct SummaryGame {
    #[diesel(sql_type = BigInt, column_name = EventID)]
    event_id: i64,
    #[diesel(sql_type = BigInt, column_name = SiteID)]
    site_id: i64,
    #[diesel(sql_type = Nullable<Text>, column_name = Date)]
    date: Option<String>,
    #[diesel(sql_type = BigInt, column_name = WhiteID)]
    white_id: i64,
    #[diesel(sql_type = BigInt, column_name = BlackID)]
    black_id: i64,
    #[diesel(sql_type = Nullable<Double>, column_name = WhiteElo)]
    white_elo: Option<f64>,
    #[diesel(sql_type = Nullable<Double>, column_name = BlackElo)]
    black_elo: Option<f64>,
}

#[derive(Default)]
struct Summary {
    game_count: i64,
    start_date: Option<String>,
    end_date: Option<String>,
    players: HashSet<i64>,
    sites: HashMap<i64, i64>,
    rating_sum: f64,
    rating_count: i64,
}

impl Summary {
    fn add(&mut self, game: SummaryGame) {
        self.game_count += 1;
        if let Some(date) = game.date.filter(|date| !date.starts_with('?')) {
            // Rust string ordering compares UTF-8 bytes, matching SQLite BINARY.
            if self.start_date.as_ref().is_none_or(|start| date < *start) {
                self.start_date = Some(date.clone());
            }
            if self.end_date.as_ref().is_none_or(|end| date > *end) {
                self.end_date = Some(date);
            }
        }
        for id in [game.white_id, game.black_id] {
            if id != 0 {
                self.players.insert(id);
            }
        }
        if game.site_id != 0 {
            *self.sites.entry(game.site_id).or_default() += 1;
        }
        let mut row_rating = 0.0;
        for rating in [game.white_elo, game.black_elo].into_iter().flatten() {
            if rating > 0.0 {
                row_rating += rating;
                self.rating_count += 1;
            }
        }
        self.rating_sum += row_rating;
    }
}

/// Refresh exactly the dirty non-zero events in the caller's write transaction.
/// Retain only per-event counters, date bounds and distinct players and sites.
pub(super) fn refresh_event_summaries(
    conn: &mut SqliteConnection,
    source: RowSource,
) -> Result<(), Error> {
    #[cfg(test)]
    LAST_ROW_SOURCE.with(|record| record.set(Some(source)));
    #[cfg(test)]
    REFRESH_COUNT.with(|count| count.set(count.get() + 1));

    let mut summaries: HashMap<i64, Summary> =
        sql_query("SELECT ID FROM EventSummaryDirty WHERE ID != 0")
            .load::<DirtyEvent>(conn)?
            .into_iter()
            .map(|event| (event.id, Summary::default()))
            .collect();

    if !summaries.is_empty() {
        // The iterator releases its statement and connection borrow before any writes.
        {
            let rows =
                sql_query(source.sql()).load_iter::<SummaryGame, DefaultLoadingMode>(conn)?;
            for game in rows {
                let game = game?;
                if let Some(summary) = summaries.get_mut(&game.event_id) {
                    summary.add(game);
                }
            }
        }
        for (id, summary) in summaries {
            let site_id = summary
                .sites
                .iter()
                .max_by_key(|(id, count)| (**count, std::cmp::Reverse(**id)))
                .map_or(0, |(id, _)| *id);
            // Float-to-integer conversion saturates like SQLite's CAST AS INTEGER.
            let avg_elo = (summary.rating_count != 0)
                .then(|| (summary.rating_sum / summary.rating_count as f64).round() as i64);
            sql_query(
                "UPDATE Events SET StartDate = ?, EndDate = ?, SiteID = ?,
                 GameCount = ?, PlayerCount = ?, AvgElo = ? WHERE ID = ?",
            )
            .bind::<Nullable<Text>, _>(summary.start_date)
            .bind::<Nullable<Text>, _>(summary.end_date)
            .bind::<BigInt, _>(site_id)
            .bind::<BigInt, _>(summary.game_count)
            .bind::<BigInt, _>(summary.players.len() as i64)
            .bind::<Nullable<BigInt>, _>(avg_elo)
            .bind::<BigInt, _>(id)
            .execute(conn)?;
        }
    }
    conn.batch_execute("DELETE FROM EventSummaryDirty;")?;
    Ok(())
}
