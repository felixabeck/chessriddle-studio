//! Opening statistics from the user's reference database, as evidence for the model.

use async_trait::async_trait;
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use crate::{db::PositionStats, error::Error, infra::path_authority::DatabaseHandle, AppState};

/// Moves of a position that are passed on, most played first.
pub(crate) const MAX_STATS_MOVES: usize = 12;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct MoveStats {
    pub san: String,
    pub white: u64,
    pub draw: u64,
    pub black: u64,
    /// Every game with the move, also those without a recorded result.
    pub games: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum StatsError {
    Cancelled,
    /// The database could not answer. This is never the same as "no games".
    Unavailable,
}

#[async_trait]
pub(crate) trait Statistics: Send {
    /// The moves played in the reference database from the position `fen`.
    async fn moves(&mut self, fen: &str) -> Result<Vec<MoveStats>, StatsError>;
}

fn count(value: i32) -> u64 {
    u64::try_from(value).unwrap_or(0)
}

impl From<PositionStats> for MoveStats {
    fn from(stats: PositionStats) -> Self {
        let (white, draw, black) = (count(stats.white), count(stats.draw), count(stats.black));
        Self {
            san: stats.move_,
            white,
            draw,
            black,
            games: white + draw + black + count(stats.unknown),
        }
    }
}

/// The statistics as the model reads them: the total, and the most played moves.
pub(crate) fn stats_document(stats: &[MoveStats]) -> Value {
    let mut ordered: Vec<&MoveStats> = stats.iter().collect();
    ordered.sort_by(|a, b| b.games.cmp(&a.games).then_with(|| a.san.cmp(&b.san)));
    let games: u64 = stats.iter().map(|entry| entry.games).sum();
    let moves: Vec<Value> = ordered
        .iter()
        .take(MAX_STATS_MOVES)
        .map(|entry| {
            json!({
                "move": entry.san,
                "games": entry.games,
                "white_wins": entry.white,
                "draws": entry.draw,
                "black_wins": entry.black,
            })
        })
        .collect();
    json!({ "games": games, "moves": moves })
}

/// The reference database the user chose, searched through the existing stats-only position
/// search with its cache, under the turn's cancellation.
pub(crate) struct DatabaseStatistics<R: tauri::Runtime> {
    state: AppState,
    app: tauri::AppHandle<R>,
    /// The id the search reports its progress under: the turn's id, which no view listens to.
    progress_id: String,
    database: DatabaseHandle,
    cancellation: CancellationToken,
}

impl<R: tauri::Runtime> DatabaseStatistics<R> {
    pub(crate) fn new(
        state: AppState,
        app: tauri::AppHandle<R>,
        progress_id: String,
        database: DatabaseHandle,
        cancellation: CancellationToken,
    ) -> Self {
        Self {
            state,
            app,
            progress_id,
            database,
            cancellation,
        }
    }
}

#[async_trait]
impl<R: tauri::Runtime> Statistics for DatabaseStatistics<R> {
    async fn moves(&mut self, fen: &str) -> Result<Vec<MoveStats>, StatsError> {
        let found = crate::db::position_stats_for_operation(
            &self.state,
            self.app.clone(),
            self.progress_id.clone(),
            self.database.clone(),
            fen.to_owned(),
            &self.cancellation,
        )
        .await;
        match found {
            Ok(stats) => Ok(stats.into_iter().map(MoveStats::from).collect()),
            Err(Error::Cancellation) => Err(StatsError::Cancelled),
            Err(error) => {
                log::warn!("coach: opening statistics failed: {}", error.diagnostic());
                Err(StatsError::Unavailable)
            }
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A database double: answers every position from a script.
    #[derive(Default)]
    pub(crate) struct ScriptedStatistics {
        pub asked: Vec<String>,
        pub answer: Option<Result<Vec<MoveStats>, StatsError>>,
    }

    #[async_trait]
    impl Statistics for ScriptedStatistics {
        async fn moves(&mut self, fen: &str) -> Result<Vec<MoveStats>, StatsError> {
            self.asked.push(fen.to_owned());
            self.answer.clone().unwrap_or_else(|| Ok(Vec::new()))
        }
    }

    pub(crate) fn played(san: &str, white: u64, draw: u64, black: u64) -> MoveStats {
        MoveStats {
            san: san.into(),
            white,
            draw,
            black,
            games: white + draw + black,
        }
    }

    #[test]
    fn the_document_totals_all_games_and_lists_the_most_played_moves_first() {
        let mut stats: Vec<MoveStats> = (0..15)
            .map(|index| played(&format!("m{index:02}"), index, 1, 0))
            .collect();
        stats.push(played("a3", 0, 0, 0));
        let document = stats_document(&stats);
        let total: u64 = (0..15).map(|index| index + 1).sum();
        assert_eq!(document["games"], total);
        let moves = document["moves"].as_array().unwrap();
        assert_eq!(moves.len(), MAX_STATS_MOVES);
        assert_eq!(moves[0]["move"], "m14");
        assert_eq!(moves[0]["games"], 15);
        assert_eq!(moves[0]["white_wins"], 14);
        assert_eq!(moves[0]["draws"], 1);
        assert_eq!(moves[0]["black_wins"], 0);
        assert_eq!(moves[11]["move"], "m03");

        assert_eq!(stats_document(&[]), json!({ "games": 0, "moves": [] }));
    }

    #[test]
    fn games_without_a_result_count_as_games_and_bad_counts_as_zero() {
        let stats = MoveStats::from(PositionStats {
            move_: "e4".into(),
            white: 3,
            draw: 2,
            black: -5,
            unknown: 4,
            last_played: None,
            year_counts: Vec::new(),
            recent: Vec::new(),
        });
        assert_eq!(
            stats,
            MoveStats {
                san: "e4".into(),
                white: 3,
                draw: 2,
                black: 0,
                games: 9
            }
        );
    }
}
