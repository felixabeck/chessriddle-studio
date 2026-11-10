//! Allowlisted training wire boundary. Solution text lives only while building a DTO.

use crate::chessriddle::AccountError;
use serde::{Deserialize, Serialize};
use shakmaty::{fen::Fen, uci::UciMove, CastlingMode, Chess, Color, EnPassantMode, Position};
use specta::Type;

// Mirrors the server submission contract.
pub(crate) const MAX_TRAINING_SUBMISSION_PLIES: usize = 7;
// Mirrors the server duration contract.
pub(crate) const MAX_TRAINING_DURATION_MS: u32 = 86_400_000;
// Mirrors the server exclusion contract.
pub(crate) const MAX_TRAINING_EXCLUSIONS: usize = 50;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) enum TrainingSource {
    Tactics,
    Mistakes,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TrainingSettings {
    pub difficulty: i32,
    pub motif: Option<String>,
    pub show_timer: bool,
    pub timer_mode: String,
    pub timer_duration: u32,
}

pub(crate) fn valid_motif(value: &str) -> bool {
    (1..=50).contains(&value.len()) && value.bytes().all(|byte| byte.is_ascii_alphanumeric())
}

pub(crate) fn validate_filters(
    source: TrainingSource,
    difficulty: Option<i32>,
    motif: Option<&str>,
) -> Result<(), AccountError> {
    if (source == TrainingSource::Mistakes && (difficulty.is_some() || motif.is_some()))
        || difficulty.is_some_and(|value| ![-500, -250, 0, 250, 500].contains(&value))
        || motif.is_some_and(|value| !valid_motif(value))
    {
        return Err(AccountError::InvalidRequest);
    }
    Ok(())
}

impl TrainingSettings {
    pub(crate) fn body(&self) -> Result<serde_json::Value, AccountError> {
        validate_filters(
            TrainingSource::Tactics,
            Some(self.difficulty),
            self.motif.as_deref(),
        )?;
        if !matches!(self.timer_mode.as_str(), "up" | "down")
            || !(1..=3600).contains(&self.timer_duration)
        {
            return Err(AccountError::InvalidRequest);
        }
        Ok(serde_json::json!({
            "puzzle_difficulty_offset": self.difficulty,
            "selected_motif": self.motif,
            "show_timer": self.show_timer,
            "timer_mode": self.timer_mode,
            "timer_duration": self.timer_duration,
        }))
    }
}

pub(crate) fn settings(body: &[u8]) -> Result<TrainingSettings, AccountError> {
    #[derive(Deserialize)]
    struct Wire {
        puzzle_difficulty_offset: serde_json::Value,
        selected_motif: Option<serde_json::Value>,
        show_timer: bool,
        timer_mode: serde_json::Value,
        timer_duration: serde_json::Value,
    }
    let wire: Wire = serde_json::from_slice(body).map_err(|_| AccountError::Server)?;
    Ok(TrainingSettings {
        difficulty: wire
            .puzzle_difficulty_offset
            .as_i64()
            .filter(|value| [-500, -250, 0, 250, 500].contains(value))
            .map_or(0, |value| value as i32),
        motif: wire.selected_motif.and_then(|value| {
            value
                .as_str()
                .filter(|name| valid_motif(name))
                .map(str::to_owned)
        }),
        show_timer: wire.show_timer,
        timer_mode: wire
            .timer_mode
            .as_str()
            .filter(|value| matches!(*value, "up" | "down"))
            .unwrap_or("up")
            .into(),
        timer_duration: wire
            .timer_duration
            .as_u64()
            .filter(|value| (1..=3600).contains(value))
            .map_or(300, |value| value as u32),
    })
}

pub(crate) fn motifs(body: &[u8]) -> Result<Vec<String>, AccountError> {
    #[derive(Deserialize)]
    struct Wire {
        motifs: Vec<serde_json::Value>,
    }
    let wire: Wire = serde_json::from_slice(body).map_err(|_| AccountError::Server)?;
    let mut names = Vec::new();
    for value in wire.motifs {
        if let Some(name) = value
            .get("name")
            .and_then(serde_json::Value::as_str)
            .filter(|name| valid_motif(name))
        {
            if !names.iter().any(|value| value == name) {
                names.push(name.to_owned());
            }
        }
        if names.len() == 200 {
            break;
        }
    }
    Ok(names)
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
        solution_ply_count: (tokens.len() - 1).min(MAX_TRAINING_SUBMISSION_PLIES) as u8,
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
    pub motif: Option<String>,
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
    motif: Option<String>,
}

pub(crate) fn submit_body(request: &TrainingSubmission) -> Result<SubmitBody, AccountError> {
    validate_filters(request.source, None, request.motif.as_deref())?;
    position(&request.decision_fen).map_err(|_| AccountError::InvalidRequest)?;
    if request.puzzle_id <= 0
        || request.line.len() > MAX_TRAINING_SUBMISSION_PLIES
        || request.elapsed_ms > MAX_TRAINING_DURATION_MS
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
        motif: request.motif.clone(),
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
        });
    let reason = value
        .pointer("/details/reason")
        .and_then(serde_json::Value::as_str)
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
    // Specific reasons refine generic envelope codes such as CONFLICT and FORBIDDEN.
    let specific_reason = match (status, reason) {
        (403, Some("desktop_route_forbidden")) => Some(AccountError::UpdateRequired),
        (409, Some("submission_in_progress")) => Some(AccountError::SubmissionInProgress),
        _ => None,
    };
    if let Some(error) = specific_reason {
        return error;
    }
    match (status, code) {
        (404 | 503, Some("PUZZLE_FILTER_NO_MATCH")) => AccountError::NoMatch,
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

    #[test]
    fn settings_normalise_reads_and_validate_every_renderer_field() {
        let valid = json!({"puzzle_difficulty_offset":250,"selected_motif":"mateIn2","show_timer":true,"timer_mode":"down","timer_duration":180,"secret":"hidden"});
        let dto = settings(&serde_json::to_vec(&valid).unwrap()).unwrap();
        assert_eq!(dto.difficulty, 250);
        assert_eq!(dto.body().unwrap().as_object().unwrap().len(), 5);
        assert_eq!(dto.body().unwrap()["selected_motif"], "mateIn2");
        assert_eq!(
            serde_json::to_value(&dto)
                .unwrap()
                .as_object()
                .unwrap()
                .len(),
            5
        );
        for (field, bad) in [
            ("puzzle_difficulty_offset", json!(42)),
            ("puzzle_difficulty_offset", json!(0.5)),
            ("selected_motif", json!("bad/value")),
            ("timer_mode", json!("other")),
            ("timer_duration", json!(0)),
            ("timer_duration", json!(3601)),
            ("timer_duration", json!(-1)),
        ] {
            let mut wire = valid.clone();
            wire[field] = bad;
            let normal = settings(&serde_json::to_vec(&wire).unwrap()).unwrap();
            match field {
                "puzzle_difficulty_offset" => assert_eq!(normal.difficulty, 0),
                "selected_motif" => assert_eq!(normal.motif, None),
                "timer_mode" => assert_eq!(normal.timer_mode, "up"),
                _ => assert_eq!(normal.timer_duration, 300),
            }
        }
        for difficulty in [-501, -1, 1, 501] {
            assert_eq!(
                TrainingSettings {
                    difficulty,
                    ..dto.clone()
                }
                .body(),
                Err(AccountError::InvalidRequest)
            );
        }
        for motif in ["", "a_b", "ä", &"a".repeat(51)] {
            assert_eq!(
                TrainingSettings {
                    motif: Some(motif.into()),
                    ..dto.clone()
                }
                .body(),
                Err(AccountError::InvalidRequest)
            );
            assert!(validate_filters(TrainingSource::Tactics, None, Some(motif)).is_err());
        }
        for mode in ["", "sideways"] {
            assert!(TrainingSettings {
                timer_mode: mode.into(),
                ..dto.clone()
            }
            .body()
            .is_err());
        }
        for duration in [0, 3601] {
            assert!(TrainingSettings {
                timer_duration: duration,
                ..dto.clone()
            }
            .body()
            .is_err());
        }
        assert!(validate_filters(TrainingSource::Mistakes, Some(0), None).is_err());
        assert!(validate_filters(TrainingSource::Mistakes, None, Some("fork")).is_err());
        let mut request = request();
        request.motif = Some("fork".into());
        assert_eq!(
            serde_json::to_value(submit_body(&request).unwrap()).unwrap()["motif"],
            "fork"
        );
        request.source = TrainingSource::Mistakes;
        assert!(submit_body(&request).is_err());
    }

    #[test]
    fn motifs_are_bounded_deduplicated_allowlisted_names() {
        let mut values = vec![
            json!({"name":"fork","secret":"hidden"}),
            json!({"name":"fork"}),
            json!({"name":"bad_motif"}),
            json!({"name":null}),
            json!({"name":""}),
            json!("raw"),
        ];
        values.extend((0..250).map(|index| json!({"name":format!("motif{index}")})));
        let result =
            motifs(&serde_json::to_vec(&json!({"motifs":values,"secret":"hidden"})).unwrap())
                .unwrap();
        assert_eq!(result.len(), 200);
        assert_eq!(result[0], "fork");
        assert_eq!(result[1], "motif0");
        for status in [404, 503] {
            assert_eq!(
                server_error(status, br#"{"code":"PUZZLE_FILTER_NO_MATCH"}"#),
                AccountError::NoMatch
            );
        }
        assert_eq!(
            server_error(403, br#"{"detail":{"code":"desktop_route_forbidden"}}"#),
            AccountError::UpdateRequired
        );
    }
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
            motif: None,
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
        assert_eq!(dto["correctVariation"], json!(["e7e5", "g1f3", "b8c6"]));
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
                json!({"error":{"code":"DAILY_LIMIT_REACHED","message":"Daily limit reached","details":{"limit":10}}}),
                AccountError::DailyLimit,
            ),
            (
                403,
                json!({"error":{"code":"FORBIDDEN","message":"Desktop route forbidden","details":{"reason":"desktop_route_forbidden"}}}),
                AccountError::UpdateRequired,
            ),
            (
                409,
                json!({"error":{"code":"CLIENT_UPDATE_REQUIRED","message":"Client update required","details":null}}),
                AccountError::UpdateRequired,
            ),
            (
                409,
                json!({"error":{"code":"CONFLICT","message":"Submission in progress","details":{"reason":"submission_in_progress","retry_after_ms":1000}}}),
                AccountError::SubmissionInProgress,
            ),
            (429, json!({"message":"secret"}), AccountError::RateLimited),
            (
                504,
                json!({"error":{"code":"ENGINE_TIMEOUT","message":"Engine timed out","details":null}}),
                AccountError::EngineTimeout,
            ),
            (
                503,
                json!({"error":{"code":"ENGINE_BUSY","message":"Engine busy","details":null}}),
                AccountError::EngineBusy,
            ),
            (
                503,
                json!({"error":{"code":"ENGINE_UNAVAILABLE","message":"Engine unavailable","details":null}}),
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
