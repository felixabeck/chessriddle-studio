//! One Coach turn: the engine's baseline and the database's statistics, the bounded model loop
//! with its tools, and the checked answer.

use async_trait::async_trait;
use tokio_util::sync::CancellationToken;

use super::{
    answer::Answer,
    backend::{Message, ModelBackend, ToolCall},
    driver::TurnOutcome,
    engine::Analyst,
    error::CoachError,
    lines::{terminal, TurnPosition},
    model_loop::{self, LoopOutcome, ModelRounds, ProgressSink, ToolExecutor},
    prompt::{self, Baseline, DatabaseEvidence, Evidence},
    stats::{Statistics, StatsError},
    tools::{self, ToolActivity, ToolSource},
};
#[cfg(test)]
use super::{
    backend::{Round, RoundFailure, RoundRequest},
    model_loop::{MAX_ROUNDS, MAX_TOOL_CALLS_PER_ROUND},
};

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
    /// What the player's repertoire files play from the position: untrusted text.
    pub repertoire: Option<String>,
    /// The repertoire files were only partly read.
    pub repertoire_partial: bool,
}

struct CoachTools<'a, 'b> {
    turn: &'a TurnPosition,
    analyst: &'a mut dyn Analyst,
    statistics: Option<&'a mut (dyn Statistics + 'b)>,
}

#[async_trait]
impl ToolExecutor<ToolActivity> for CoachTools<'_, '_> {
    async fn execute(
        &mut self,
        call: &ToolCall,
        on_activity: &mut (dyn FnMut(ToolActivity) + Send),
    ) -> Result<String, CoachError> {
        tools::execute(
            call,
            self.turn,
            self.analyst,
            self.statistics.as_deref_mut(),
            &mut |activity| on_activity(activity.clone()),
        )
        .await
    }
}

pub(crate) type TurnEnd = TurnOutcome<Answer>;

fn failed(error: CoachError, text: String) -> TurnEnd {
    TurnEnd::Failed { error, text }
}

/// Runs one turn. `statistics` is the player's reference database, if one is chosen.
pub(crate) async fn run_turn(
    backend: &dyn ModelBackend,
    analyst: &mut dyn Analyst,
    mut statistics: Option<&mut (dyn Statistics + '_)>,
    turn: &TurnPosition,
    request: &TurnRequest,
    sink: &mut dyn ProgressSink<ToolActivity>,
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
    // Then the reference database: what is played from the position. A finished game has no
    // moves to look up, and a database that does not answer now is not asked again in this turn.
    if matches!(baseline, Baseline::Terminal(_)) {
        statistics = None;
    }
    let mut database = None;
    if let Some(source) = statistics.as_deref_mut() {
        sink.tool(ToolActivity {
            source: ToolSource::Database,
            line: Vec::new(),
        });
        database = Some(match source.moves(&turn.fen()).await {
            Ok(moves) => DatabaseEvidence::Moves(moves),
            Err(StatsError::Cancelled) => return failed(CoachError::Cancelled, String::new()),
            Err(StatsError::Unavailable) => DatabaseEvidence::Unavailable,
        });
    }
    if matches!(database, Some(DatabaseEvidence::Unavailable)) {
        statistics = None;
    }
    let evidence = Evidence { baseline, database };
    let mut messages = request.history.clone();
    messages.push(Message::User(prompt::user_message(
        turn, &evidence, request,
    )));
    let tools = tools::specs(statistics.is_some());
    let rounds = ModelRounds {
        backend,
        model: &request.model,
        effort: request.effort.as_deref(),
        system: prompt::SYSTEM_PROMPT,
        tools: &tools,
        cancellation,
    };
    let mut executor = CoachTools {
        turn,
        analyst,
        statistics,
    };
    match model_loop::run(&rounds, messages, &mut executor, sink).await {
        LoopOutcome::Answered { text, messages } => {
            finish(&rounds, turn, messages, text, sink).await
        }
        LoopOutcome::Failed { error, text } => failed(error, text),
    }
}

/// Checks the final text. Lines that are not legal get one repair round; whatever is still not
/// legal afterwards stays in the answer as plain text.
async fn finish(
    rounds: &ModelRounds<'_>,
    turn: &TurnPosition,
    mut messages: Vec<Message>,
    text: String,
    sink: &mut dyn ProgressSink<ToolActivity>,
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
    // A repair that asks for a tool instead of answering has failed.
    match rounds.ask(&messages, &mut |delta| sink.text(delta)).await {
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
        backend::{TextSink, ToolCall},
        stats::tests::{played, ScriptedStatistics},
        tools::tests::{ScriptedAnalyst, START},
    };
    use async_trait::async_trait;
    use std::sync::Mutex;

    pub(crate) type Script = Result<Round, RoundFailure>;

    #[derive(Clone)]
    pub(crate) struct SeenRound {
        pub(crate) model: String,
        pub(crate) system: String,
        pub(crate) messages: Vec<Message>,
        pub(crate) effort: Option<String>,
        pub(crate) tools: Vec<&'static str>,
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

        pub(crate) fn seen_round(&self, round: usize) -> SeenRound {
            self.seen.lock().unwrap()[round].clone()
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
                    model: request.model.to_owned(),
                    system: request.system.to_owned(),
                    messages: request.messages.to_vec(),
                    effort: request.effort.map(str::to_owned),
                    tools: request.tools.iter().map(|tool| tool.name).collect(),
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
                if !round.text.is_empty() {
                    on_text(&round.text);
                }
            }
            next
        }
    }

    #[derive(Default)]
    struct Recorded {
        events: Vec<String>,
    }

    impl ProgressSink<ToolActivity> for Recorded {
        fn text(&mut self, delta: &str) {
            self.events.push(format!("text:{delta}"));
        }
        fn reset(&mut self) {
            self.events.push("reset".into());
        }
        fn tool(&mut self, activity: ToolActivity) {
            let source = match activity.source {
                ToolSource::Engine => "tool",
                ToolSource::Database => "database",
            };
            self.events
                .push(format!("{source}:{}", activity.line.join(" ")));
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
                    extra_content: None,
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
            repertoire: None,
            repertoire_partial: false,
        }
    }

    fn named_calls(calls: &[(&str, &str)]) -> Script {
        Ok(Round {
            tool_calls: calls
                .iter()
                .enumerate()
                .map(|(index, (name, arguments))| ToolCall {
                    id: format!("call_{index}"),
                    name: (*name).into(),
                    arguments: (*arguments).into(),
                    extra_content: None,
                })
                .collect(),
            ..Round::default()
        })
    }

    async fn play_with_database(
        backend: &ScriptedBackend,
        statistics: &mut ScriptedStatistics,
        turn: &TurnPosition,
    ) -> (TurnEnd, Vec<String>) {
        let mut sink = Recorded::default();
        let end = run_turn(
            backend,
            &mut ScriptedAnalyst::default(),
            Some(statistics),
            turn,
            &request(),
            &mut sink,
            &CancellationToken::new(),
        )
        .await;
        (end, sink.events)
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
            None,
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
    async fn the_database_is_asked_about_the_position_before_the_model_and_offered_as_a_tool() {
        let backend = ScriptedBackend::new(vec![
            named_calls(&[(tools::OPENING_STATS, r#"{"line":"Nf3"}"#)]),
            text("[[Nf3]] is the main move."),
        ]);
        let mut statistics = ScriptedStatistics {
            answer: Some(Ok(vec![played("Nf3", 60, 30, 10)])),
            ..Default::default()
        };
        let (end, events) = play_with_database(&backend, &mut statistics, &turn()).await;
        assert!(matches!(end, TurnEnd::Completed(_)));
        assert_eq!(
            statistics.asked,
            [
                "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2",
                "rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2",
            ]
        );
        let Message::User(context) = backend.messages(0).pop().unwrap() else {
            panic!("context");
        };
        assert!(context.contains("reference database: {\"games\":100,"));
        assert_eq!(
            backend.seen.lock().unwrap()[0].tools,
            [tools::ANALYSE, tools::OPENING_STATS]
        );
        let Message::ToolResult { content, .. } = backend.messages(1).pop().unwrap() else {
            panic!("the lookup's result");
        };
        assert!(content.contains("\"games\":100"));
        assert_eq!(
            events,
            [
                "database:",
                "database:Nf3",
                "reset",
                "text:[[Nf3]] is the main move."
            ]
        );
    }

    #[tokio::test]
    async fn without_a_database_the_tool_is_not_offered_and_nothing_is_said_about_one() {
        let backend = ScriptedBackend::new(vec![text("Fine.")]);
        let (_, events) = play(&backend, &mut ScriptedAnalyst::default(), &turn()).await;
        assert_eq!(backend.seen.lock().unwrap()[0].tools, [tools::ANALYSE]);
        let Message::User(context) = backend.messages(0).pop().unwrap() else {
            panic!("context");
        };
        assert!(!context.contains("reference database"));
        assert_eq!(events, ["text:Fine."]);
    }

    #[tokio::test]
    async fn a_database_that_fails_at_the_start_is_named_and_not_offered_for_the_turn() {
        let backend = ScriptedBackend::new(vec![
            named_calls(&[(tools::OPENING_STATS, "{}")]),
            text("Fine."),
        ]);
        let mut statistics = ScriptedStatistics {
            answer: Some(Err(StatsError::Unavailable)),
            ..Default::default()
        };
        let (end, _) = play_with_database(&backend, &mut statistics, &turn()).await;
        assert!(matches!(end, TurnEnd::Completed(_)));
        let Message::User(context) = backend.messages(0).pop().unwrap() else {
            panic!("context");
        };
        assert!(context.contains("could not be read for this question"));
        assert_eq!(backend.seen.lock().unwrap()[0].tools, [tools::ANALYSE]);
        // A model that calls the tool anyway is told so; the database is not asked again.
        let Message::ToolResult { content, .. } = backend.messages(1).pop().unwrap() else {
            panic!("the refused call's result");
        };
        assert!(content.contains("No reference database"));
        assert_eq!(statistics.asked.len(), 1);
    }

    #[tokio::test]
    async fn a_cancelled_lookup_ends_the_turn_and_a_finished_game_is_not_looked_up() {
        let backend = ScriptedBackend::new(Vec::new());
        let mut cancelled = ScriptedStatistics {
            answer: Some(Err(StatsError::Cancelled)),
            ..Default::default()
        };
        let (end, _) = play_with_database(&backend, &mut cancelled, &turn()).await;
        assert_eq!(end, failed(CoachError::Cancelled, String::new()));
        assert_eq!(backend.rounds(), 0);

        let mated = TurnPosition::new(START, &line(&["f2f3", "e7e5", "g2g4", "d8h4"])).unwrap();
        let backend = ScriptedBackend::new(vec![text("White is checkmated.")]);
        let mut statistics = ScriptedStatistics::default();
        let (end, events) = play_with_database(&backend, &mut statistics, &mated).await;
        assert!(matches!(end, TurnEnd::Completed(_)));
        assert!(statistics.asked.is_empty());
        assert_eq!(backend.seen.lock().unwrap()[0].tools, [tools::ANALYSE]);
        assert_eq!(events, ["text:White is checkmated."]);
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
            None,
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

    #[tokio::test]
    async fn run_turn_forwards_the_requested_model_and_system_prompt() {
        let backend = ScriptedBackend::new(vec![text("Fine.")]);
        let (end, _) = play(&backend, &mut ScriptedAnalyst::default(), &turn()).await;
        assert!(matches!(end, TurnEnd::Completed(_)));
        let seen = backend.seen_round(0);
        assert_eq!(seen.model, "test-model");
        assert_eq!(seen.system, prompt::SYSTEM_PROMPT);
    }
}
