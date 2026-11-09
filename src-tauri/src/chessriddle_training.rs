//! Allowlisted training wire boundary. Solution text lives only while building a DTO.

use crate::chessriddle::AccountError;
use serde::{Deserialize, Serialize};
use shakmaty::{fen::Fen, uci::UciMove, CastlingMode, Chess, Color, EnPassantMode, Position};
use specta::Type;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) enum TrainingSource {
    Tactics,
    Mistakes,
}

#[derive(Clone, Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TrainingPuzzle {
    pub id: i32,
    pub source: TrainingSource,
    pub pre_entrance_fen: String,
    pub entrance_move: String,
    pub decision_fen: String,
    pub side_to_move: TrainingSide,
    pub puzzle_rating: f64,
    pub solution_ply_count: u8,
}

#[derive(Clone, Copy, Debug, Serialize, Type)]
#[serde(rename_all = "lowercase")]
pub(crate) enum TrainingSide {
    White,
    Black,
}

#[derive(Deserialize)]
struct PuzzleWire {
    id: i64,
    puzzle_type: String,
    tactic_puzzle: Option<TacticWire>,
}

#[derive(Deserialize)]
struct TacticWire {
    tactic_rating: f64,
    fen_position: String,
    principal_variation: String,
}

fn position(fen: &str) -> Result<Chess, AccountError> {
    let fen: Fen = fen.parse().map_err(|_| AccountError::Server)?;
    fen.into_position(CastlingMode::Standard)
        .map_err(|_| AccountError::Server)
}

fn uci(token: &str) -> Result<UciMove, AccountError> {
    // Null moves, drops, SAN and noncanonical promotions are outside this contract.
    let bytes = token.as_bytes();
    if !(bytes.len() == 4 || bytes.len() == 5)
        || !matches!(bytes[0], b'a'..=b'h')
        || !matches!(bytes[1], b'1'..=b'8')
        || !matches!(bytes[2], b'a'..=b'h')
        || !matches!(bytes[3], b'1'..=b'8')
        || (bytes.len() == 5 && !matches!(bytes[4], b'q' | b'r' | b'b' | b'n'))
        || (bytes.len() == 5 && !matches!(bytes[3], b'1' | b'8'))
    {
        return Err(AccountError::Server);
    }
    token.parse().map_err(|_| AccountError::Server)
}

fn play(pos: &mut Chess, token: &str) -> Result<(), AccountError> {
    let mv = uci(token)?.to_move(pos).map_err(|_| AccountError::Server)?;
    pos.play_unchecked(&mv);
    Ok(())
}

pub(crate) fn puzzle(
    body: &[u8],
    source: TrainingSource,
) -> Result<Option<TrainingPuzzle>, AccountError> {
    let wire: Option<PuzzleWire> =
        serde_json::from_slice(body).map_err(|_| AccountError::Server)?;
    let Some(wire) = wire else {
        return if source == TrainingSource::Mistakes {
            Ok(None)
        } else {
            Err(AccountError::Server)
        };
    };
    let id = i32::try_from(wire.id)
        .ok()
        .filter(|id| *id > 0)
        .ok_or(AccountError::Server)?;
    if wire.puzzle_type != "TACTIC" {
        return Err(AccountError::Server);
    }
    let tactic = wire.tactic_puzzle.ok_or(AccountError::Server)?;
    let tokens: Vec<&str> = tactic.principal_variation.split_whitespace().collect();
    if tokens.len() < 2 || !tactic.tactic_rating.is_finite() {
        return Err(AccountError::Server);
    }
    for token in &tokens {
        uci(token)?;
    }
    let mut pos = position(&tactic.fen_position)?;
    play(&mut pos, tokens[0])?;
    Ok(Some(TrainingPuzzle {
        id,
        source,
        pre_entrance_fen: tactic.fen_position,
        entrance_move: tokens[0].to_string(),
        decision_fen: Fen::from_position(pos.clone(), EnPassantMode::Legal).to_string(),
        side_to_move: match pos.turn() {
            Color::White => TrainingSide::White,
            Color::Black => TrainingSide::Black,
        },
        puzzle_rating: tactic.tactic_rating,
        solution_ply_count: (tokens.len() - 1).min(7) as u8,
    }))
}

#[derive(Clone, Debug, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TrainingSubmission {
    pub puzzle_id: i32,
    pub source: TrainingSource,
    pub decision_fen: String,
    pub line: Vec<String>,
    pub elapsed_ms: u32,
    pub solution_shown: bool,
    pub idempotency_key: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct VariationNode {
    r#move: String,
    children: Vec<VariationNode>,
}

#[derive(Debug, Serialize)]
pub(crate) struct SubmitBody {
    variation_tree: VariationNode,
    time_taken_ms: u32,
    is_rated: bool,
    solution_shown: bool,
}

pub(crate) fn submit_body(request: &TrainingSubmission) -> Result<SubmitBody, AccountError> {
    position(&request.decision_fen).map_err(|_| AccountError::InvalidRequest)?;
    if request.puzzle_id <= 0
        || request.line.len() > 7
        || request.elapsed_ms > 86_400_000
        || request.idempotency_key.len() > 36
        || uuid::Uuid::parse_str(&request.idempotency_key).is_err()
        || (request.line.is_empty() && !request.solution_shown)
    {
        return Err(AccountError::InvalidRequest);
    }
    let mut children = Vec::new();
    for token in request.line.iter().rev() {
        uci(token).map_err(|_| AccountError::InvalidRequest)?;
        children = vec![VariationNode {
            r#move: token.clone(),
            children,
        }];
    }
    let variation_tree = children.pop().unwrap_or(VariationNode {
        r#move: String::new(),
        children: vec![],
    });
    Ok(SubmitBody {
        variation_tree,
        time_taken_ms: request.elapsed_ms,
        is_rated: request.source == TrainingSource::Tactics && !request.solution_shown,
        solution_shown: request.solution_shown,
    })
}

#[derive(Clone, Copy, Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) enum TrainingFeedbackCode {
    Correct,
    Incorrect,
    LineTooShort,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, Type)]
#[serde(rename_all = "lowercase")]
pub(crate) enum TrainingFeedbackContext {
    Analysis,
    Retry,
}

#[derive(Clone, Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TrainingVerdict {
    pub is_correct: bool,
    pub too_short: bool,
    pub rating_change: f64,
    pub player_rating: Option<f64>,
    pub puzzle_rating: f64,
    pub rated: bool,
    pub rating_pending: bool,
    pub feedback_code: TrainingFeedbackCode,
    pub feedback_context: Option<TrainingFeedbackContext>,
    pub correct_variation: Vec<String>,
    pub incorrect_move: Option<String>,
    pub correct_move: Option<String>,
}

#[derive(Deserialize)]
struct VerdictWire {
    is_correct: bool,
    #[serde(default)]
    is_on_path_too_short: bool,
    rating_change: f64,
    player_rating: Option<f64>,
    puzzle_rating: f64,
    rated: Option<bool>,
    #[serde(default)]
    rating_pending: bool,
    feedback_descriptor: Option<DescriptorWire>,
    correct_variation: String,
    incorrect_move_uci: Option<String>,
    correct_move_uci: Option<String>,
}

#[derive(Deserialize)]
struct DescriptorWire {
    code: String,
    params: Option<serde_json::Value>,
}

pub(crate) fn verdict(body: &[u8], decision_fen: &str) -> Result<TrainingVerdict, AccountError> {
    let wire: VerdictWire = serde_json::from_slice(body).map_err(|_| AccountError::Server)?;
    let mut pos = position(decision_fen)?;
    let mut line: Vec<String> = wire
        .correct_variation
        .split_whitespace()
        .map(str::to_string)
        .collect();
    // The verdict is already stored. Bad optional move data must not make it retryable.
    if line.iter().any(|token| play(&mut pos, token).is_err()) {
        line.clear();
    }
    let fallback = if wire.is_correct {
        TrainingFeedbackCode::Correct
    } else {
        TrainingFeedbackCode::Incorrect
    };
    let (feedback_code, feedback_context) = match wire.feedback_descriptor {
        Some(descriptor) => {
            let known = match descriptor.code.as_str() {
                "correct" => Some(TrainingFeedbackCode::Correct),
                "incorrect" => Some(TrainingFeedbackCode::Incorrect),
                "line_too_short" => Some(TrainingFeedbackCode::LineTooShort),
                _ => None,
            };
            let context = descriptor
                .params
                .and_then(|params| params.get("context").cloned())
                .and_then(|value| serde_json::from_value(value).ok());
            (
                known.unwrap_or(fallback),
                if known.is_some() { context } else { None },
            )
        }
        None => (fallback, None),
    };
    Ok(TrainingVerdict {
        is_correct: wire.is_correct,
        too_short: wire.is_on_path_too_short,
        rating_change: wire.rating_change,
        player_rating: wire.player_rating,
        puzzle_rating: wire.puzzle_rating,
        rated: wire.rated.unwrap_or(false),
        rating_pending: wire.rating_pending,
        feedback_code,
        feedback_context,
        correct_variation: line,
        incorrect_move: wire.incorrect_move_uci.filter(|token| uci(token).is_ok()),
        correct_move: wire.correct_move_uci.filter(|token| uci(token).is_ok()),
    })
}

pub(crate) fn mistake_count(body: &[u8]) -> Result<u32, AccountError> {
    #[derive(Deserialize)]
    struct Count {
        count: u32,
    }
    serde_json::from_slice::<Count>(body)
        .map(|value| value.count)
        .map_err(|_| AccountError::Server)
}

pub(crate) fn server_error(status: u16, body: &[u8]) -> AccountError {
    let value = serde_json::from_slice::<serde_json::Value>(body).unwrap_or_default();
    let code = value
        .get("code")
        .and_then(serde_json::Value::as_str)
        .or_else(|| {
            value
                .pointer("/error/code")
                .and_then(serde_json::Value::as_str)
        })
        .or_else(|| {
            value
                .pointer("/detail/code")
                .and_then(serde_json::Value::as_str)
        })
        .or_else(|| {
            value
                .pointer("/details/reason")
                .and_then(serde_json::Value::as_str)
        })
        .or_else(|| {
            value
                .pointer("/error/details/reason")
                .and_then(serde_json::Value::as_str)
        })
        .or_else(|| {
            value
                .pointer("/detail/details/reason")
                .and_then(serde_json::Value::as_str)
        });
    match (status, code) {
        (429, _) => AccountError::RateLimited,
        (403, Some("DAILY_LIMIT_REACHED")) => AccountError::DailyLimit,
        (403, Some("desktop_route_forbidden")) | (409, Some("CLIENT_UPDATE_REQUIRED")) => {
            AccountError::UpdateRequired
        }
        (409, Some("submission_in_progress")) => AccountError::SubmissionInProgress,
        (_, Some("ENGINE_TIMEOUT")) => AccountError::EngineTimeout,
        (_, Some("ENGINE_BUSY")) => AccountError::EngineBusy,
        (_, Some("ENGINE_UNAVAILABLE")) => AccountError::EngineUnavailable,
        (401, _) => AccountError::Authentication,
        (400 | 422, _) => AccountError::InvalidRequest,
        _ => AccountError::Server,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    pub(super) const PUZZLE: &str =
        include_str!("chessriddle_training_samples/puzzle_response.json");
    pub(super) const VERDICT: &str =
        include_str!("chessriddle_training_samples/verdict_correct.json");

    fn request() -> TrainingSubmission {
        TrainingSubmission {
            puzzle_id: 1,
            source: TrainingSource::Tactics,
            decision_fen: puzzle(PUZZLE.as_bytes(), TrainingSource::Tactics)
                .unwrap()
                .unwrap()
                .decision_fen,
            line: vec!["e7e5".into(), "g1f3".into()],
            elapsed_ms: 30000,
            solution_shown: false,
            idempotency_key: "bfe2ba6e-b195-4e7d-8b1e-5919ac36a37c".into(),
        }
    }

    #[test]
    fn golden_requests_are_built_natively() {
        let mut request = request();
        assert_eq!(
            serde_json::to_value(submit_body(&request).unwrap()).unwrap(),
            serde_json::from_str::<Value>(include_str!(
                "chessriddle_training_samples/submit_request_line.json"
            ))
            .unwrap()
        );
        request.line.clear();
        request.solution_shown = true;
        assert_eq!(
            serde_json::to_value(submit_body(&request).unwrap()).unwrap(),
            serde_json::from_str::<Value>(include_str!(
                "chessriddle_training_samples/submit_request_reveal.json"
            ))
            .unwrap()
        );
        request.solution_shown = false;
        assert!(submit_body(&request).is_err());
        request.line = vec!["e7e5".into()];
        request.source = TrainingSource::Mistakes;
        assert!(!submit_body(&request).unwrap().is_rated);
        for token in ["0000", "e7e5q", "Nf3", "a9a1"] {
            request.line = vec![token.into()];
            assert!(submit_body(&request).is_err());
        }
        request.line = vec!["e7e5".into(); 8];
        assert!(submit_body(&request).is_err());
        request.line = vec!["e7e5".into()];
        request.elapsed_ms = 86_400_001;
        assert!(submit_body(&request).is_err());
        request.elapsed_ms = 1;
        request.idempotency_key = "bad".into();
        assert!(submit_body(&request).is_err());
    }

    #[test]
    fn puzzle_dto_has_only_allowlisted_keys_and_no_solution() {
        let puzzle = puzzle(PUZZLE.as_bytes(), TrainingSource::Tactics)
            .unwrap()
            .unwrap();
        let dto = serde_json::to_value(&puzzle).unwrap();
        let mut keys: Vec<_> = dto
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort();
        assert_eq!(
            keys,
            [
                "decisionFen",
                "entranceMove",
                "id",
                "preEntranceFen",
                "puzzleRating",
                "sideToMove",
                "solutionPlyCount",
                "source"
            ]
        );
        let serialized = dto.to_string();
        for hidden in [
            "e7e5",
            "g1f3",
            "b8c6",
            "explanation",
            "future_field",
            "principal_variation",
        ] {
            assert!(!serialized.contains(hidden));
        }
        assert_eq!(puzzle.solution_ply_count, 3);
        assert_eq!(dto["sideToMove"], "black");
    }

    #[test]
    fn malformed_puzzles_and_out_of_range_ids_are_closed_errors() {
        for (path, value) in [
            ("/id", json!(2147483648_i64)),
            ("/puzzle_type", json!("STRATEGY")),
            ("/tactic_puzzle", Value::Null),
            ("/tactic_puzzle/fen_position", json!("bad")),
            ("/tactic_puzzle/principal_variation", json!("e2e5 e7e5")),
            ("/tactic_puzzle/principal_variation", json!("e2e4 Nf6")),
        ] {
            let mut wire: Value = serde_json::from_str(PUZZLE).unwrap();
            *wire.pointer_mut(path).unwrap() = value;
            assert!(matches!(
                puzzle(&serde_json::to_vec(&wire).unwrap(), TrainingSource::Tactics),
                Err(AccountError::Server)
            ));
        }
    }

    #[test]
    fn golden_verdict_is_allowlisted_and_legally_replayed() {
        let decision = puzzle(PUZZLE.as_bytes(), TrainingSource::Tactics)
            .unwrap()
            .unwrap()
            .decision_fen;
        let dto = serde_json::to_value(verdict(VERDICT.as_bytes(), &decision).unwrap()).unwrap();
        let mut keys: Vec<_> = dto
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort();
        assert_eq!(
            keys,
            [
                "correctMove",
                "correctVariation",
                "feedbackCode",
                "feedbackContext",
                "incorrectMove",
                "isCorrect",
                "playerRating",
                "puzzleRating",
                "rated",
                "ratingChange",
                "ratingPending",
                "tooShort"
            ]
        );
        for hidden in [
            "feedback_message",
            "coach_explanation",
            "source_game_url",
            "Well done",
            "Develop",
            "lichess",
        ] {
            assert!(!dto.to_string().contains(hidden));
        }
        let short = verdict(
            include_str!("chessriddle_training_samples/verdict_too_short.json").as_bytes(),
            &decision,
        )
        .unwrap();
        assert!(short.too_short);
        assert!(short.correct_variation.is_empty());
        let mut wire: Value = serde_json::from_str(VERDICT).unwrap();
        wire["feedback_descriptor"] =
            json!({"code":"unknown server text", "params":{"context":"arbitrary"}});
        assert!(matches!(
            verdict(&serde_json::to_vec(&wire).unwrap(), &decision)
                .unwrap()
                .feedback_code,
            TrainingFeedbackCode::Correct
        ));
    }

    #[test]
    fn submit_refuses_invalid_decision_fen_before_building_wire_body() {
        for fen in ["not a fen", "8/8/8/8/8/8/8/8 w - - 0 1"] {
            let mut request = request();
            request.decision_fen = fen.into();
            assert!(matches!(
                submit_body(&request),
                Err(AccountError::InvalidRequest)
            ));
        }
    }

    #[test]
    fn stored_verdict_defaults_missing_too_short_to_false() {
        let mut wire: Value = serde_json::from_str(VERDICT).unwrap();
        wire.as_object_mut().unwrap().remove("is_on_path_too_short");
        let dto = verdict(&serde_json::to_vec(&wire).unwrap(), &request().decision_fen).unwrap();
        assert!(!dto.too_short);
        assert!(dto.is_correct);
        assert_eq!(dto.rating_change, 8.0);
    }

    #[test]
    fn stored_verdict_defaults_missing_rating_pending_to_false() {
        let mut wire: Value = serde_json::from_str(VERDICT).unwrap();
        wire.as_object_mut().unwrap().remove("rating_pending");
        let dto = verdict(&serde_json::to_vec(&wire).unwrap(), &request().decision_fen).unwrap();
        assert!(!dto.rating_pending);
        assert!(dto.is_correct);
        assert_eq!(dto.rating_change, 8.0);
    }

    #[test]
    fn stored_verdict_maps_null_rated_to_false() {
        let mut wire: Value = serde_json::from_str(VERDICT).unwrap();
        wire["rated"] = Value::Null;
        let dto = verdict(&serde_json::to_vec(&wire).unwrap(), &request().decision_fen).unwrap();
        assert!(!dto.rated);
        assert!(dto.is_correct);
        assert_eq!(dto.rating_change, 8.0);
    }

    #[test]
    fn stored_verdict_discards_the_whole_variation_on_a_non_uci_token() {
        let mut wire: Value = serde_json::from_str(VERDICT).unwrap();
        wire["correct_variation"] = json!("e7e5 Nf3");
        let dto = verdict(&serde_json::to_vec(&wire).unwrap(), &request().decision_fen).unwrap();
        assert!(dto.correct_variation.is_empty());
        assert!(dto.is_correct);
        assert_eq!(dto.rating_change, 8.0);
    }

    #[test]
    fn stored_verdict_discards_the_whole_variation_on_an_illegal_move() {
        let mut wire: Value = serde_json::from_str(VERDICT).unwrap();
        wire["correct_variation"] = json!("e7e5 e2e5");
        let dto = verdict(&serde_json::to_vec(&wire).unwrap(), &request().decision_fen).unwrap();
        assert!(dto.correct_variation.is_empty());
        assert!(dto.is_correct);
        assert_eq!(dto.rating_change, 8.0);
    }

    #[test]
    fn stored_verdict_omits_non_uci_incorrect_and_correct_moves() {
        for field in ["incorrect_move_uci", "correct_move_uci"] {
            let mut wire: Value = serde_json::from_str(VERDICT).unwrap();
            wire["incorrect_move_uci"] = json!("e7e5");
            wire["correct_move_uci"] = json!("d7d5");
            wire[field] = json!("server prose");
            let dto =
                verdict(&serde_json::to_vec(&wire).unwrap(), &request().decision_fen).unwrap();
            if field == "incorrect_move_uci" {
                assert!(dto.incorrect_move.is_none());
                assert_eq!(dto.correct_move.as_deref(), Some("d7d5"));
            } else {
                assert!(dto.correct_move.is_none());
                assert_eq!(dto.incorrect_move.as_deref(), Some("e7e5"));
            }
            assert!(dto.is_correct);
            assert_eq!(dto.rating_change, 8.0);
        }
    }

    #[test]
    fn golden_null_and_count() {
        assert!(puzzle(
            include_str!("chessriddle_training_samples/mistake_null.json").as_bytes(),
            TrainingSource::Mistakes
        )
        .unwrap()
        .is_none());
        assert_eq!(
            mistake_count(
                include_str!("chessriddle_training_samples/mistake_count.json").as_bytes()
            )
            .unwrap(),
            1
        );
    }

    #[test]
    fn each_server_error_shape_is_closed() {
        for (status, body, expected) in [
            (
                403,
                json!({"code":"DAILY_LIMIT_REACHED"}),
                AccountError::DailyLimit,
            ),
            (
                403,
                json!({"detail":{"details":{"reason":"desktop_route_forbidden"}}}),
                AccountError::UpdateRequired,
            ),
            (
                409,
                json!({"detail":{"code":"CLIENT_UPDATE_REQUIRED"}}),
                AccountError::UpdateRequired,
            ),
            (
                409,
                json!({"detail":{"code":"submission_in_progress"}}),
                AccountError::SubmissionInProgress,
            ),
            (429, json!({"message":"secret"}), AccountError::RateLimited),
            (
                504,
                json!({"code":"ENGINE_TIMEOUT"}),
                AccountError::EngineTimeout,
            ),
            (503, json!({"code":"ENGINE_BUSY"}), AccountError::EngineBusy),
            (
                503,
                json!({"code":"ENGINE_UNAVAILABLE"}),
                AccountError::EngineUnavailable,
            ),
            (500, json!({"message":"secret"}), AccountError::Server),
        ] {
            assert_eq!(
                server_error(status, &serde_json::to_vec(&body).unwrap()),
                expected
            );
        }
    }
}
