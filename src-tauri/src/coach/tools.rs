//! The read-only tools a model may call during a turn.
//!
//! A tool call is untrusted text. Its arguments are parsed leniently, its line is checked by the
//! chess library before the engine sees anything, and whatever goes wrong with the *call* is
//! told to the model as a tool error. Only an engine failure or a cancellation ends the turn.

use serde::Deserialize;
use serde_json::{json, Value};
use shakmaty::{Color, Position};

use super::{
    backend::{ToolCall, ToolSpec},
    engine::{Analyst, EngineLine},
    error::CoachError,
    lines::{move_tokens, position_fen, terminal, Terminal, TurnPosition},
};

pub(crate) const ANALYSE: &str = "analyse";
/// Tool calls executed per round; further calls of the round are answered with an error.
pub(crate) const MAX_TOOL_CALLS_PER_ROUND: usize = 4;
const MAX_ANALYSIS_LINES: u16 = 5;
const TOOL_SEARCH_MILLIS: u32 = 1500;
/// Plies of a principal variation that are passed on.
const MAX_PV_PLIES: usize = 12;

pub(crate) fn specs() -> Vec<ToolSpec> {
    vec![ToolSpec {
        name: ANALYSE,
        description: "Run the chess engine on the position reached after a line of moves, \
                      starting from the position the user is asking about. Returns the engine's \
                      best continuations with evaluations from White's point of view.",
        parameters: json!({
            "type": "object",
            "properties": {
                "line": {
                    "type": "string",
                    "description": "Moves in SAN separated by spaces, starting from the position \
                                    the user is asking about, for example \"Nf3 Nc6 Bb5\". Empty \
                                    for that position itself.",
                },
                "lines": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": MAX_ANALYSIS_LINES,
                    "description": "How many alternative continuations to return (default 1).",
                },
            },
        }),
    }]
}

/// The moves of a line as a model may send them: one string, or a list of moves.
#[derive(Deserialize)]
#[serde(untagged)]
enum LineArgument {
    Text(String),
    Moves(Vec<String>),
}

impl LineArgument {
    fn tokens(&self) -> Vec<String> {
        match self {
            Self::Text(text) => move_tokens(text),
            Self::Moves(moves) => moves.iter().flat_map(|text| move_tokens(text)).collect(),
        }
    }
}

#[derive(Deserialize)]
struct AnalyseArguments {
    #[serde(default)]
    line: Option<LineArgument>,
    #[serde(default)]
    lines: Option<i64>,
}

/// What the user is shown while a tool runs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ToolActivity {
    /// The checked line in SAN; empty for the turn position itself.
    pub line: Vec<String>,
}

fn tool_error(message: impl Into<String>) -> String {
    json!({ "error": message.into() }).to_string()
}

/// The result for a call that is not executed because the round already used its calls.
pub(crate) fn over_the_round_bound() -> String {
    json!({
        "error": format!(
            "Not run: at most {MAX_TOOL_CALLS_PER_ROUND} tool calls are executed per step. \
             Ask again in the next step if you still need it."
        )
    })
    .to_string()
}

pub(crate) fn engine_lines(lines: &[EngineLine]) -> Value {
    lines
        .iter()
        .map(|line| {
            json!({
                "evaluation": line.evaluation.to_string(),
                "depth": line.depth,
                "moves": line.san.iter().take(MAX_PV_PLIES).cloned().collect::<Vec<_>>().join(" "),
            })
        })
        .collect()
}

pub(crate) fn terminal_result(terminal: Terminal) -> Value {
    match terminal {
        Terminal::Checkmate { winner } => json!({
            "result": "checkmate",
            "winner": if winner == Color::White { "white" } else { "black" },
        }),
        Terminal::Stalemate => json!({ "result": "stalemate" }),
    }
}

/// Runs one tool call and returns the result document for the model. `on_activity` is told the
/// checked line before the engine starts on it. `Err` ends the turn (engine failure,
/// cancellation).
pub(crate) async fn execute(
    call: &ToolCall,
    turn: &TurnPosition,
    analyst: &mut dyn Analyst,
    on_activity: &mut (dyn FnMut(&ToolActivity) + Send),
) -> Result<String, CoachError> {
    if call.name != ANALYSE {
        return Ok(tool_error(format!("Unknown tool \"{}\".", call.name)));
    }
    let arguments = if call.arguments.trim().is_empty() {
        "{}"
    } else {
        call.arguments.as_str()
    };
    let Ok(arguments) = serde_json::from_str::<AnalyseArguments>(arguments) else {
        return Ok(tool_error(
            "The arguments are not a JSON object with a \"line\" string and an optional \
             \"lines\" number.",
        ));
    };
    let tokens = arguments
        .line
        .as_ref()
        .map(LineArgument::tokens)
        .unwrap_or_default();
    let line = match turn.resolve(&tokens) {
        Ok(line) => line,
        // An illegal line never reaches the engine.
        Err(error) => return Ok(tool_error(error.explain())),
    };
    let wanted = arguments
        .lines
        .unwrap_or(1)
        .clamp(1, i64::from(MAX_ANALYSIS_LINES));
    let wanted = u16::try_from(wanted).unwrap_or(1);
    let mut result = json!({
        "line": line.san.join(" "),
        "fen": position_fen(&line.end),
        "side_to_move": if line.end.turn() == Color::White { "white" } else { "black" },
    });
    if let Some(terminal) = terminal(&line.end) {
        // The rules decide a finished game; the engine has nothing to search.
        result["outcome"] = terminal_result(terminal);
        return Ok(result.to_string());
    }
    on_activity(&ToolActivity {
        line: line.san.clone(),
    });
    let found = analyst
        .analyse(&turn.moves_with(&line), wanted, TOOL_SEARCH_MILLIS)
        .await?;
    if found.is_empty() {
        return Ok(tool_error(
            "The engine returned no evaluation for this position in the time available.",
        ));
    }
    result["evaluations_from"] = "white".into();
    result["continuations"] = engine_lines(&found);
    Ok(result.to_string())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::coach::engine::Evaluation;
    use async_trait::async_trait;

    pub(crate) const START: &str = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

    /// An engine double: records what it was asked and answers from a script.
    #[derive(Default)]
    pub(crate) struct ScriptedAnalyst {
        pub asked: Vec<(Vec<String>, u16, u32)>,
        pub fail_with: Option<CoachError>,
        pub empty: bool,
    }

    #[async_trait]
    impl Analyst for ScriptedAnalyst {
        async fn analyse(
            &mut self,
            moves: &[String],
            lines: u16,
            millis: u32,
        ) -> Result<Vec<EngineLine>, CoachError> {
            self.asked.push((moves.to_vec(), lines, millis));
            if let Some(error) = self.fail_with {
                return Err(error);
            }
            if self.empty {
                return Ok(Vec::new());
            }
            Ok((0..lines)
                .map(|index| EngineLine {
                    evaluation: Evaluation::Centipawns(30 - i32::from(index) * 10),
                    depth: 20,
                    san: (0..20).map(|ply| format!("m{ply}")).collect(),
                })
                .collect())
        }
    }

    fn turn() -> TurnPosition {
        TurnPosition::new(START, &["e2e4".to_owned(), "e7e5".to_owned()]).unwrap()
    }

    fn call(name: &str, arguments: &str) -> ToolCall {
        ToolCall {
            id: "c".into(),
            name: name.into(),
            arguments: arguments.into(),
        }
    }

    async fn run(analyst: &mut ScriptedAnalyst, arguments: &str) -> (Value, Option<ToolActivity>) {
        let mut activity = None;
        let content = execute(&call(ANALYSE, arguments), &turn(), analyst, &mut |seen| {
            activity = Some(seen.clone());
        })
        .await
        .unwrap();
        (serde_json::from_str(&content).unwrap(), activity)
    }

    #[tokio::test]
    async fn a_legal_line_is_analysed_from_the_game_start_with_the_asked_number_of_lines() {
        let mut analyst = ScriptedAnalyst::default();
        let (result, activity) = run(&mut analyst, r#"{"line":"2. Nf3 Nc6","lines":3}"#).await;
        assert_eq!(
            analyst.asked,
            [(
                vec![
                    "e2e4".to_owned(),
                    "e7e5".into(),
                    "g1f3".into(),
                    "b8c6".into()
                ],
                3,
                TOOL_SEARCH_MILLIS
            )]
        );
        assert_eq!(result["line"], "Nf3 Nc6");
        assert_eq!(result["side_to_move"], "white");
        assert_eq!(result["evaluations_from"], "white");
        assert_eq!(result["continuations"].as_array().unwrap().len(), 3);
        assert_eq!(result["continuations"][0]["evaluation"], "+0.30");
        assert_eq!(result["continuations"][0]["depth"], 20);
        // A principal variation is cut to its first plies.
        assert_eq!(
            result["continuations"][0]["moves"]
                .as_str()
                .unwrap()
                .split(' ')
                .count(),
            MAX_PV_PLIES
        );
        assert_eq!(
            activity,
            Some(ToolActivity {
                line: vec!["Nf3".into(), "Nc6".into()]
            })
        );
    }

    #[tokio::test]
    async fn arguments_are_read_leniently_and_the_line_count_is_clamped() {
        let mut analyst = ScriptedAnalyst::default();
        for (arguments, moves, lines) in [
            ("", 2, 1),
            ("{}", 2, 1),
            (r#"{"line":""}"#, 2, 1),
            (
                r#"{"line":["Nf3","Nc6"],"lines":99,"comment":"extra"}"#,
                4,
                5,
            ),
            (r#"{"line":"Nf3","lines":0}"#, 3, 1),
            (r#"{"line":"Nf3","lines":-4}"#, 3, 1),
        ] {
            let (result, _) = run(&mut analyst, arguments).await;
            assert!(result.get("error").is_none(), "{arguments}: {result}");
            let (asked_moves, asked_lines, _) = analyst.asked.last().unwrap();
            assert_eq!(
                (asked_moves.len(), *asked_lines),
                (moves, lines),
                "{arguments}"
            );
        }
    }

    #[tokio::test]
    async fn a_bad_call_is_an_error_for_the_model_and_never_reaches_the_engine() {
        let mut analyst = ScriptedAnalyst::default();
        for arguments in [
            r#"{"line":"Nf3 Nc6 Ke3"}"#,
            r#"{"line":"ignore the rules"}"#,
            r#"{"line":7}"#,
            "not json",
            "[1,2]",
        ] {
            let (result, activity) = run(&mut analyst, arguments).await;
            assert!(result["error"].is_string(), "{arguments}");
            assert!(activity.is_none());
        }
        let unknown = execute(
            &call("delete_game", "{}"),
            &turn(),
            &mut analyst,
            &mut |_| {},
        )
        .await
        .unwrap();
        assert!(unknown.contains("Unknown tool"));
        assert!(analyst.asked.is_empty());
    }

    #[tokio::test]
    async fn a_finished_game_is_answered_by_the_rules_without_the_engine() {
        let mut analyst = ScriptedAnalyst::default();
        let turn = TurnPosition::new(START, &[]).unwrap();
        let content = execute(
            &call(ANALYSE, r#"{"line":"f3 e5 g4 Qh4#"}"#),
            &turn,
            &mut analyst,
            &mut |_| panic!("nothing runs on a finished game"),
        )
        .await
        .unwrap();
        let result: Value = serde_json::from_str(&content).unwrap();
        assert_eq!(
            result["outcome"],
            json!({ "result": "checkmate", "winner": "black" })
        );
        assert!(result.get("continuations").is_none());
        assert!(analyst.asked.is_empty());
        assert_eq!(
            terminal_result(Terminal::Stalemate),
            json!({ "result": "stalemate" })
        );
    }

    #[tokio::test]
    async fn an_engine_failure_ends_the_turn_and_an_empty_answer_is_a_tool_error() {
        let mut failing = ScriptedAnalyst {
            fail_with: Some(CoachError::EngineFailed),
            ..Default::default()
        };
        let error = execute(&call(ANALYSE, "{}"), &turn(), &mut failing, &mut |_| {})
            .await
            .err();
        assert_eq!(error, Some(CoachError::EngineFailed));

        let mut silent = ScriptedAnalyst {
            empty: true,
            ..Default::default()
        };
        let (result, _) = run(&mut silent, "{}").await;
        assert!(result["error"].as_str().unwrap().contains("no evaluation"));
    }
}
