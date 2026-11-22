//! The engine behind a Coach turn: one private process per turn, started on first use.

use async_trait::async_trait;
use tokio_util::sync::CancellationToken;
use vampirc_uci::uci::ScoreValue;

use super::error::CoachError;
use crate::{
    chess::AnalysisSession,
    engine::{EngineKey, EngineOption, GoMode},
    error::Error,
    infra::path_authority::EngineHandle,
    AppState,
};

/// An engine evaluation from White's point of view.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Evaluation {
    Centipawns(i32),
    /// Positive: White mates in that many moves. Negative: Black does.
    Mate(i32),
}

impl std::fmt::Display for Evaluation {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match *self {
            Self::Centipawns(centipawns) => {
                write!(formatter, "{:+.2}", f64::from(centipawns) / 100.0)
            }
            Self::Mate(moves) if moves >= 0 => write!(formatter, "White mates in {moves}"),
            Self::Mate(moves) => write!(formatter, "Black mates in {}", moves.unsigned_abs()),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct EngineLine {
    pub evaluation: Evaluation,
    pub depth: u32,
    /// The principal variation in SAN, from the analysed position.
    pub san: Vec<String>,
}

#[async_trait]
pub(crate) trait Analyst: Send {
    /// Searches the position after `moves` (UCI, from the game start) for `millis` and returns up
    /// to `lines` principal variations, best first. `Err` ends the turn.
    async fn analyse(
        &mut self,
        moves: &[String],
        lines: u16,
        millis: u32,
    ) -> Result<Vec<EngineLine>, CoachError>;
}

/// The user's chosen local engine, run as a private process under the turn's analysis key.
pub(crate) struct EngineAnalyst {
    state: AppState,
    key: EngineKey,
    engine: EngineHandle,
    engine_id: String,
    uci_options: Vec<EngineOption>,
    cancellation: CancellationToken,
    start_fen: String,
    session: Option<AnalysisSession>,
}

fn evaluation(score: &ScoreValue) -> Evaluation {
    match *score {
        ScoreValue::Cp(centipawns) => Evaluation::Centipawns(centipawns),
        ScoreValue::Mate(moves) => Evaluation::Mate(moves),
    }
}

fn engine_failure(error: &Error) -> CoachError {
    if matches!(error, Error::AnalysisCancelled | Error::Cancellation) {
        CoachError::Cancelled
    } else {
        log::warn!("coach: engine failed: {}", error.diagnostic());
        CoachError::EngineFailed
    }
}

impl EngineAnalyst {
    pub(crate) fn new(
        state: AppState,
        key: EngineKey,
        engine: EngineHandle,
        engine_id: String,
        uci_options: Vec<EngineOption>,
        cancellation: CancellationToken,
        start_fen: String,
    ) -> Self {
        Self {
            state,
            key,
            engine,
            engine_id,
            uci_options,
            cancellation,
            start_fen,
            session: None,
        }
    }

    /// Ends the engine process, if one was started. Called on every way a turn ends.
    pub(crate) async fn finish(self) {
        if let Some(session) = self.session {
            if let Err(error) = session.terminate().await {
                log::warn!("coach: engine did not end cleanly: {}", error.diagnostic());
            }
        }
    }
}

#[async_trait]
impl Analyst for EngineAnalyst {
    async fn analyse(
        &mut self,
        moves: &[String],
        lines: u16,
        millis: u32,
    ) -> Result<Vec<EngineLine>, CoachError> {
        let session = match &mut self.session {
            Some(session) => session,
            empty => {
                let started = AnalysisSession::start(
                    &self.state,
                    self.key.clone(),
                    self.engine.clone(),
                    self.engine_id.clone(),
                    self.uci_options.clone(),
                    self.cancellation.clone(),
                )
                .await
                .map_err(|error| engine_failure(&error))?;
                empty.insert(started)
            }
        };
        session
            .ensure_active()
            .map_err(|error| engine_failure(&error))?;
        let analysis = session
            .analyze(&self.start_fen, moves, lines, &GoMode::Time(millis))
            .await
            .map_err(|error| engine_failure(&error))?;
        Ok(analysis
            .iter()
            .map(|line| EngineLine {
                evaluation: evaluation(&line.score().value),
                depth: line.depth(),
                san: line.san_moves().to_vec(),
            })
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn evaluations_read_from_whites_point_of_view() {
        assert_eq!(Evaluation::Centipawns(35).to_string(), "+0.35");
        assert_eq!(Evaluation::Centipawns(-120).to_string(), "-1.20");
        assert_eq!(Evaluation::Centipawns(0).to_string(), "+0.00");
        assert_eq!(Evaluation::Mate(3).to_string(), "White mates in 3");
        assert_eq!(Evaluation::Mate(-2).to_string(), "Black mates in 2");
        assert_eq!(
            evaluation(&ScoreValue::Cp(-35)),
            Evaluation::Centipawns(-35)
        );
        assert_eq!(evaluation(&ScoreValue::Mate(4)), Evaluation::Mate(4));
        assert_eq!(evaluation(&ScoreValue::Mate(-1)), Evaluation::Mate(-1));
    }

    #[test]
    fn a_cancelled_engine_is_a_cancelled_turn_and_every_other_failure_an_engine_failure() {
        for cancelled in [Error::AnalysisCancelled, Error::Cancellation] {
            assert_eq!(engine_failure(&cancelled), CoachError::Cancelled);
        }
        for failed in [
            Error::EngineDisconnected,
            Error::EngineTimeout("no bestmove".into()),
        ] {
            assert_eq!(engine_failure(&failed), CoachError::EngineFailed);
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn one_engine_process_serves_a_turns_searches_and_ends_with_the_turn() {
        use tauri::Manager as _;

        const START: &str = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
        let (directory, app, engine) = crate::chess::scripted_analysis_engine();
        // The scripted engine answers `go` at once.
        std::fs::write(directory.path().join("release"), b"").unwrap();
        let capture =
            || std::fs::read_to_string(directory.path().join("capture.log")).unwrap_or_default();
        let cancellation = CancellationToken::new();
        let mut analyst = EngineAnalyst::new(
            app.state::<AppState>().inner().clone(),
            EngineKey::new("analysis".into(), "coach-engine-test".into()).unwrap(),
            engine,
            "coach-engine".into(),
            Vec::new(),
            cancellation.clone(),
            START.into(),
        );
        // Nothing is started before the first search.
        assert_eq!(capture(), "");

        let lines = analyst.analyse(&[], 2, 20).await.unwrap();
        assert_eq!(
            lines,
            vec![
                EngineLine {
                    evaluation: Evaluation::Centipawns(12),
                    depth: 1,
                    san: vec!["e4".into()],
                },
                EngineLine {
                    evaluation: Evaluation::Centipawns(8),
                    depth: 1,
                    san: vec!["d4".into()],
                },
            ]
        );
        // A second search asks for another number of lines of the same process.
        assert_eq!(analyst.analyse(&[], 1, 20).await.unwrap().len(), 1);
        let sent = capture();
        assert_eq!(sent.matches("pid=").count(), 1, "{sent}");
        assert_eq!(sent.matches("wire=go movetime 20").count(), 2, "{sent}");
        assert!(
            sent.contains("option=setoption name MultiPV value 2"),
            "{sent}"
        );
        assert!(
            sent.contains("option=setoption name MultiPV value 1"),
            "{sent}"
        );

        // The turn's cancellation is the engine's: no further search is started.
        cancellation.cancel();
        assert_eq!(
            analyst.analyse(&[], 1, 20).await,
            Err(CoachError::Cancelled)
        );
        assert_eq!(capture().matches("wire=go").count(), 2);

        // The end of the turn ends the process.
        analyst.finish().await;
        assert!(capture().contains("wire=quit"), "{}", capture());
    }
}
