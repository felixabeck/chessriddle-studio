//! One Coach turn: the engine's baseline, the bounded model loop with its tools, and the checked
//! answer.

use tokio_util::sync::CancellationToken;

use super::{
    answer::Answer,
    backend::{Message, ModelBackend, RoundRequest},
    engine::Analyst,
    error::CoachError,
    lines::{terminal, TurnPosition},
    prompt::{self, Baseline},
    tools::{self, ToolActivity, MAX_TOOL_CALLS_PER_ROUND},
};

/// Model rounds per turn, not counting the one repair round.
pub(crate) const MAX_ROUNDS: usize = 6;
const BASELINE_LINES: u16 = 3;
const BASELINE_SEARCH_MILLIS: u32 = 2000;

/// What a turn needs besides the position: all of it already bounded by the caller.
pub(crate) struct TurnRequest {
    pub model: String,
    pub effort: Option<String>,
    /// Earlier user and coach texts of the conversation, oldest first.
    pub history: Vec<Message>,
    pub question: String,
    /// The game on the board as PGN: untrusted text.
    pub game: String,
}

/// Where the progress of a turn goes while it runs.
pub(crate) trait TurnSink: Send {
    fn text(&mut self, delta: &str);
    /// The text streamed so far is superseded by what follows.
    fn reset(&mut self);
    fn tool(&mut self, activity: &ToolActivity);
}

#[derive(Debug, PartialEq)]
pub(crate) enum TurnEnd {
    Completed(Answer),
    /// Ended without a complete answer, with the text of the round that was running.
    Failed {
        error: CoachError,
        text: String,
    },
}

fn failed(error: CoachError, text: String) -> TurnEnd {
    TurnEnd::Failed { error, text }
}

pub(crate) async fn run_turn(
    backend: &dyn ModelBackend,
    analyst: &mut dyn Analyst,
    turn: &TurnPosition,
    request: &TurnRequest,
    sink: &mut dyn TurnSink,
    cancellation: &CancellationToken,
) -> TurnEnd {
    // The engine speaks first: no model round starts without evidence about the position.
    let baseline = match terminal(turn.position()) {
        Some(terminal) => Baseline::Terminal(terminal),
        None => match analyst
            .analyse(turn.moves(), BASELINE_LINES, BASELINE_SEARCH_MILLIS)
            .await
        {
            Ok(lines) if lines.is_empty() => {
                return failed(CoachError::EngineFailed, String::new())
            }
            Ok(lines) => Baseline::Lines(lines),
            Err(error) => return failed(error, String::new()),
        },
    };
    let mut messages = request.history.clone();
    messages.push(Message::User(prompt::user_message(
        turn,
        &baseline,
        &request.game,
        &request.question,
    )));
    let tools = tools::specs();
    let mut last_text = String::new();
    for round in 0..MAX_ROUNDS {
        if cancellation.is_cancelled() {
            return failed(CoachError::Cancelled, last_text);
        }
        if round > 0 {
            sink.reset();
        }
        let answered = backend
            .round(
                RoundRequest {
                    model: &request.model,
                    effort: request.effort.as_deref(),
                    system: prompt::SYSTEM_PROMPT,
                    messages: &messages,
                    tools: &tools,
                },
                &mut |delta| sink.text(delta),
                cancellation,
            )
            .await;
        let answered = match answered {
            Ok(round) => round,
            Err(failure) => return failed(failure.error, failure.text),
        };
        if answered.tool_calls.is_empty() {
            return finish(
                backend,
                turn,
                request,
                messages,
                answered.text,
                sink,
                cancellation,
            )
            .await;
        }
        last_text.clone_from(&answered.text);
        let calls = answered.tool_calls.clone();
        messages.push(answered.into_message());
        for (index, call) in calls.iter().enumerate() {
            let content = if index < MAX_TOOL_CALLS_PER_ROUND {
                let outcome =
                    tools::execute(call, turn, analyst, &mut |activity| sink.tool(activity)).await;
                match outcome {
                    Ok(content) => content,
                    Err(error) => return failed(error, last_text),
                }
            } else {
                // Every call needs a result, so the surplus is answered instead of dropped.
                tools::over_the_round_bound()
            };
            messages.push(Message::ToolResult {
                call_id: call.id.clone(),
                content,
            });
        }
    }
    failed(CoachError::LimitExceeded, last_text)
}

/// Checks the final text. Lines that are not legal get one repair round; whatever is still not
/// legal afterwards stays in the answer as plain text.
async fn finish(
    backend: &dyn ModelBackend,
    turn: &TurnPosition,
    request: &TurnRequest,
    mut messages: Vec<Message>,
    text: String,
    sink: &mut dyn TurnSink,
    cancellation: &CancellationToken,
) -> TurnEnd {
    let answer = Answer::parse(&text, turn);
    if answer.failed.is_empty() {
        return TurnEnd::Completed(answer);
    }
    messages.push(Message::Assistant {
        text: text.clone(),
        tool_calls: Vec::new(),
        extra: serde_json::Map::new(),
    });
    messages.push(Message::User(prompt::repair_request(&answer.failed)));
    sink.reset();
    let tools = tools::specs();
    let repaired = backend
        .round(
            RoundRequest {
                model: &request.model,
                effort: request.effort.as_deref(),
                system: prompt::SYSTEM_PROMPT,
                messages: &messages,
                // The tools stay declared because the history refers to them; a repair that asks
                // for a tool instead of answering has failed.
                tools: &tools,
            },
            &mut |delta| sink.text(delta),
            cancellation,
        )
        .await;
    match repaired {
        Ok(round) if round.tool_calls.is_empty() => {
            let repaired = Answer::parse(&round.text, turn);
            if repaired.failed.len() <= answer.failed.len() {
                TurnEnd::Completed(repaired)
            } else {
                TurnEnd::Completed(answer)
            }
        }
        Err(failure) if failure.error == CoachError::Cancelled => {
            failed(CoachError::Cancelled, text)
        }
        // The first answer is complete; a repair that did not work out does not take it away.
        Ok(_) | Err(_) => TurnEnd::Completed(answer),
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::coach::{
        answer::Segment,
        backend::{Round, RoundFailure, TextSink, ToolCall},
        tools::tests::{ScriptedAnalyst, START},
    };
    use async_trait::async_trait;
    use std::sync::Mutex;

    pub(crate) type Script = Result<Round, RoundFailure>;

    struct SeenRound {
        messages: Vec<Message>,
        effort: Option<String>,
    }

    /// A model double: answers each round from a script and records what it was sent.
    pub(crate) struct ScriptedBackend {
        script: Mutex<Vec<Script>>,
        seen: Mutex<Vec<SeenRound>>,
        pub cancel_on_round: Option<(usize, CancellationToken)>,
    }

    impl ScriptedBackend {
        pub(crate) fn new(script: Vec<Script>) -> Self {
            Self {
                script: Mutex::new(script.into_iter().rev().collect()),
                seen: Mutex::default(),
                cancel_on_round: None,
            }
        }

        fn rounds(&self) -> usize {
            self.seen.lock().unwrap().len()
        }

        fn messages(&self, round: usize) -> Vec<Message> {
            self.seen.lock().unwrap()[round].messages.clone()
        }
    }

    #[async_trait]
    impl ModelBackend for ScriptedBackend {
        async fn round(
            &self,
            request: RoundRequest<'_>,
            on_text: &mut TextSink<'_>,
            _cancellation: &CancellationToken,
        ) -> Result<Round, RoundFailure> {
            let round = {
                let mut seen = self.seen.lock().unwrap();
                seen.push(SeenRound {
                    messages: request.messages.to_vec(),
                    effort: request.effort.map(str::to_owned),
                });
                seen.len() - 1
            };
            if let Some((at, token)) = &self.cancel_on_round {
                if *at == round {
                    token.cancel();
                }
            }
            let next = self
                .script
                .lock()
                .unwrap()
                .pop()
                .expect("the script has a round for every request");
            if let Ok(round) = &next {
                on_text(&round.text);
            }
            next
        }
    }

    #[derive(Default)]
    struct Recorded {
        events: Vec<String>,
    }

    impl TurnSink for Recorded {
        fn text(&mut self, delta: &str) {
            self.events.push(format!("text:{delta}"));
        }
        fn reset(&mut self) {
            self.events.push("reset".into());
        }
        fn tool(&mut self, activity: &ToolActivity) {
            self.events
                .push(format!("tool:{}", activity.line.join(" ")));
        }
    }

    pub(crate) fn text(value: &str) -> Script {
        Ok(Round {
            text: value.into(),
            ..Round::default()
        })
    }

    pub(crate) fn calls(text: &str, arguments: &[&str]) -> Script {
        Ok(Round {
            text: text.into(),
            tool_calls: arguments
                .iter()
                .enumerate()
                .map(|(index, arguments)| ToolCall {
                    id: format!("call_{index}"),
                    name: tools::ANALYSE.into(),
                    arguments: (*arguments).into(),
                })
                .collect(),
            ..Round::default()
        })
    }

    pub(crate) fn request() -> TurnRequest {
        TurnRequest {
            model: "test-model".into(),
            effort: Some("high".into()),
            history: vec![
                Message::User("Earlier question".into()),
                Message::Assistant {
                    text: "Earlier answer".into(),
                    tool_calls: Vec::new(),
                    extra: serde_json::Map::new(),
                },
            ],
            question: "What is the plan?".into(),
            game: "1. e4 e5 *".into(),
        }
    }

    fn turn() -> TurnPosition {
        TurnPosition::new(START, &["e2e4".to_owned(), "e7e5".to_owned()]).unwrap()
    }

    async fn play(
        backend: &ScriptedBackend,
        analyst: &mut ScriptedAnalyst,
        turn: &TurnPosition,
    ) -> (TurnEnd, Vec<String>) {
        let mut sink = Recorded::default();
        let end = run_turn(
            backend,
            analyst,
            turn,
            &request(),
            &mut sink,
            &CancellationToken::new(),
        )
        .await;
        (end, sink.events)
    }

    fn line(san: &[&str]) -> Vec<String> {
        san.iter().map(|m| (*m).to_owned()).collect()
    }

    #[tokio::test]
    async fn the_engine_baseline_is_in_the_first_request_before_any_model_round() {
        let backend = ScriptedBackend::new(vec![text("Develop with [[Nf3]].")]);
        let mut analyst = ScriptedAnalyst::default();
        let (end, events) = play(&backend, &mut analyst, &turn()).await;

        // The engine was asked about the turn position first: three lines, two seconds.
        assert_eq!(
            analyst.asked,
            [(
                line(&["e2e4", "e7e5"]),
                BASELINE_LINES,
                BASELINE_SEARCH_MILLIS
            )]
        );
        let sent = backend.messages(0);
        assert_eq!(sent.len(), 3, "history, then the context with the question");
        assert_eq!(sent[0], Message::User("Earlier question".into()));
        let Message::User(context) = &sent[2] else {
            panic!("the last message is the user's");
        };
        assert!(context.contains("Engine analysis of this position: "));
        assert!(context.contains("\"evaluation\":\"+0.30\""));
        assert!(context.ends_with("What is the plan?"));
        assert_eq!(
            backend.seen.lock().unwrap()[0].effort.as_deref(),
            Some("high")
        );

        let TurnEnd::Completed(answer) = end else {
            panic!("the turn completes");
        };
        assert_eq!(
            answer.segments,
            [
                Segment::Text {
                    text: "Develop with ".into()
                },
                Segment::Line {
                    san: line(&["Nf3"]),
                    uci: line(&["g1f3"])
                },
                Segment::Text { text: ".".into() },
            ]
        );
        assert_eq!(events, ["text:Develop with [[Nf3]]."]);
    }

    #[tokio::test]
    async fn tool_calls_are_run_and_fed_back_until_the_model_answers() {
        let backend = ScriptedBackend::new(vec![
            calls(
                "Let me check.",
                &[r#"{"line":"Nf3 Nc6"}"#, r#"{"line":"Ke2 Ke7 Ke9"}"#],
            ),
            text("[[Nf3 Nc6]] is fine."),
        ]);
        let mut analyst = ScriptedAnalyst::default();
        let (end, events) = play(&backend, &mut analyst, &turn()).await;
        assert!(matches!(end, TurnEnd::Completed(_)));
        // Baseline, then only the legal line.
        assert_eq!(analyst.asked.len(), 2);
        assert_eq!(analyst.asked[1].0, line(&["e2e4", "e7e5", "g1f3", "b8c6"]));

        let sent = backend.messages(1);
        assert!(matches!(&sent[3], Message::Assistant { tool_calls, .. } if tool_calls.len() == 2));
        let Message::ToolResult { call_id, content } = &sent[4] else {
            panic!("first tool result");
        };
        assert_eq!(call_id, "call_0");
        assert!(content.contains("\"continuations\""));
        let Message::ToolResult { call_id, content } = &sent[5] else {
            panic!("second tool result");
        };
        assert_eq!(call_id, "call_1");
        assert!(
            content.contains("\"error\""),
            "an illegal line is a tool error"
        );
        assert_eq!(
            events,
            [
                "text:Let me check.",
                "tool:Nf3 Nc6",
                "reset",
                "text:[[Nf3 Nc6]] is fine."
            ]
        );
    }

    #[tokio::test]
    async fn calls_beyond_the_round_bound_are_answered_but_not_run() {
        let six: Vec<&str> = vec![r#"{"line":"Nf3"}"#; MAX_TOOL_CALLS_PER_ROUND + 2];
        let backend = ScriptedBackend::new(vec![calls("", &six), text("Done.")]);
        let mut analyst = ScriptedAnalyst::default();
        let (end, _) = play(&backend, &mut analyst, &turn()).await;
        assert!(matches!(end, TurnEnd::Completed(_)));
        assert_eq!(analyst.asked.len(), 1 + MAX_TOOL_CALLS_PER_ROUND);
        let sent = backend.messages(1);
        let results: Vec<&String> = sent
            .iter()
            .filter_map(|message| match message {
                Message::ToolResult { content, .. } => Some(content),
                _ => None,
            })
            .collect();
        assert_eq!(results.len(), six.len(), "every call gets a result");
        assert!(results[MAX_TOOL_CALLS_PER_ROUND].contains("Not run"));
        assert!(results[MAX_TOOL_CALLS_PER_ROUND + 1].contains("Not run"));
    }

    #[tokio::test]
    async fn a_model_that_never_stops_calling_tools_hits_the_round_bound() {
        let script = (0..MAX_ROUNDS)
            .map(|round| calls(&format!("round {round}"), &[r#"{"line":"Nf3"}"#]))
            .collect();
        let backend = ScriptedBackend::new(script);
        let mut analyst = ScriptedAnalyst::default();
        let (end, _) = play(&backend, &mut analyst, &turn()).await;
        assert_eq!(
            end,
            failed(
                CoachError::LimitExceeded,
                format!("round {}", MAX_ROUNDS - 1)
            )
        );
        assert_eq!(backend.rounds(), MAX_ROUNDS);
    }

    #[tokio::test]
    async fn illegal_lines_get_one_repair_round() {
        let backend = ScriptedBackend::new(vec![
            text("Play [[Nf3 Ke3]] or [[d4]]."),
            text("Play [[Nf3 Nc6]] or [[d4]]."),
        ]);
        let mut analyst = ScriptedAnalyst::default();
        let (end, events) = play(&backend, &mut analyst, &turn()).await;
        let TurnEnd::Completed(answer) = end else {
            panic!("the turn completes");
        };
        assert!(answer.failed.is_empty());
        assert_eq!(
            answer
                .segments
                .iter()
                .filter(|segment| matches!(segment, Segment::Line { .. }))
                .count(),
            2
        );
        let sent = backend.messages(1);
        let Message::User(repair) = sent.last().unwrap() else {
            panic!("the repair request is a user message");
        };
        assert!(repair.contains("- [[Nf3 Ke3]]: Half-move 2"));
        assert_eq!(
            events,
            [
                "text:Play [[Nf3 Ke3]] or [[d4]].",
                "reset",
                "text:Play [[Nf3 Nc6]] or [[d4]]."
            ]
        );
    }

    #[tokio::test]
    async fn a_failed_repair_delivers_the_first_answer_with_the_line_as_plain_text() {
        for repair in [
            text("Play [[Nf3 Ke3]] and [[Qh8]] and [[d4]]."),
            calls("", &["{}"]),
            Err(RoundFailure::new(CoachError::RateLimited)),
        ] {
            let backend = ScriptedBackend::new(vec![text("Play [[Nf3 Ke3]] or [[d4]]."), repair]);
            let mut analyst = ScriptedAnalyst::default();
            let (end, _) = play(&backend, &mut analyst, &turn()).await;
            let TurnEnd::Completed(answer) = end else {
                panic!("the first answer is delivered");
            };
            assert_eq!(answer.failed.len(), 1);
            assert_eq!(
                answer.segments,
                [
                    Segment::Text {
                        text: "Play Nf3 Ke3 or ".into()
                    },
                    Segment::Line {
                        san: line(&["d4"]),
                        uci: line(&["d2d4"])
                    },
                    Segment::Text { text: ".".into() },
                ]
            );
            assert_eq!(backend.rounds(), 2, "there is exactly one repair round");
        }
    }

    #[tokio::test]
    async fn an_engine_failure_ends_the_turn_before_or_during_the_loop() {
        let backend = ScriptedBackend::new(Vec::new());
        let mut broken = ScriptedAnalyst {
            fail_with: Some(CoachError::EngineFailed),
            ..Default::default()
        };
        let (end, _) = play(&backend, &mut broken, &turn()).await;
        assert_eq!(end, failed(CoachError::EngineFailed, String::new()));
        assert_eq!(backend.rounds(), 0, "no model round without the baseline");

        let mut silent = ScriptedAnalyst {
            empty: true,
            ..Default::default()
        };
        let (end, _) = play(&backend, &mut silent, &turn()).await;
        assert_eq!(end, failed(CoachError::EngineFailed, String::new()));
    }

    #[tokio::test]
    async fn a_finished_game_is_described_without_asking_the_engine() {
        let mated = TurnPosition::new(START, &line(&["f2f3", "e7e5", "g2g4", "d8h4"])).unwrap();
        let backend = ScriptedBackend::new(vec![text("White is checkmated.")]);
        let mut analyst = ScriptedAnalyst::default();
        let (end, _) = play(&backend, &mut analyst, &mated).await;
        assert!(matches!(end, TurnEnd::Completed(_)));
        assert!(analyst.asked.is_empty());
        let Message::User(context) = backend.messages(0).pop().unwrap() else {
            panic!("context");
        };
        assert!(context.contains("The game is over in this position"));
    }

    #[tokio::test]
    async fn a_model_failure_keeps_the_text_of_its_round() {
        let backend = ScriptedBackend::new(vec![Err(RoundFailure {
            error: CoachError::AnswerCutOff,
            text: "Half an ans".into(),
        })]);
        let mut analyst = ScriptedAnalyst::default();
        let (end, _) = play(&backend, &mut analyst, &turn()).await;
        assert_eq!(end, failed(CoachError::AnswerCutOff, "Half an ans".into()));
    }

    #[tokio::test]
    async fn cancellation_is_observed_between_rounds_and_in_the_repair_round() {
        let cancellation = CancellationToken::new();
        let mut backend = ScriptedBackend::new(vec![calls("Checking.", &["{}"])]);
        backend.cancel_on_round = Some((0, cancellation.clone()));
        let mut analyst = ScriptedAnalyst::default();
        let mut sink = Recorded::default();
        let end = run_turn(
            &backend,
            &mut analyst,
            &turn(),
            &request(),
            &mut sink,
            &cancellation,
        )
        .await;
        assert_eq!(end, failed(CoachError::Cancelled, "Checking.".into()));
        assert_eq!(backend.rounds(), 1);

        let backend = ScriptedBackend::new(vec![
            text("Play [[Ke3]]."),
            Err(RoundFailure::new(CoachError::Cancelled)),
        ]);
        let (end, _) = play(&backend, &mut analyst, &turn()).await;
        assert_eq!(end, failed(CoachError::Cancelled, "Play [[Ke3]].".into()));
    }
}
