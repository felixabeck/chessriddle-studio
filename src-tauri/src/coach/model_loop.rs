//! The bounded model loop shared by Coach and Assistant turns.
//!
//! Runs at most [`MAX_ROUNDS`] rounds against a [`ModelBackend`], executes at most
//! [`MAX_TOOL_CALLS_PER_ROUND`] tool calls per round while answering surplus calls with an error,
//! resets streamed text between rounds, and observes cancellation between rounds.

use async_trait::async_trait;
use serde_json::json;
use tokio_util::sync::CancellationToken;

use super::{
    backend::{
        Message, ModelBackend, Round, RoundFailure, RoundRequest, TextSink, ToolCall, ToolSpec,
    },
    error::CoachError,
};

/// Model rounds per turn, not counting any caller-managed follow-up round.
pub(crate) const MAX_ROUNDS: usize = 6;
/// Tool calls executed per round; further calls of the round are answered with an error.
pub(crate) const MAX_TOOL_CALLS_PER_ROUND: usize = 4;

/// The result for a call that is not executed because the round already used its calls.
fn over_the_round_bound() -> String {
    json!({
        "error": format!(
            "Not run: at most {MAX_TOOL_CALLS_PER_ROUND} tool calls are executed per step. \
             Ask again in the next step if you still need it."
        )
    })
    .to_string()
}

/// Where the progress of a turn goes while it runs.
pub(crate) trait ProgressSink<T>: Send {
    fn text(&mut self, delta: &str);
    /// The text streamed so far is superseded by what follows.
    fn reset(&mut self);
    fn tool(&mut self, activity: T);
}

/// What every model round of one turn is asked with.
pub(crate) struct ModelRounds<'a> {
    pub backend: &'a dyn ModelBackend,
    pub model: &'a str,
    pub effort: Option<&'a str>,
    pub system: &'a str,
    /// Declared in every round, because the history refers to them.
    pub tools: &'a [ToolSpec],
    pub cancellation: &'a CancellationToken,
}

impl ModelRounds<'_> {
    pub(crate) async fn ask(
        &self,
        messages: &[Message],
        on_text: &mut TextSink<'_>,
    ) -> Result<Round, RoundFailure> {
        self.backend
            .round(
                RoundRequest {
                    model: self.model,
                    effort: self.effort,
                    system: self.system,
                    messages,
                    tools: self.tools,
                },
                on_text,
                self.cancellation,
            )
            .await
    }
}

/// Executes one tool call for the model loop.
///
/// `Ok(content)` is fed back to the model as a tool result; `Err(error)` ends the loop with the
/// text of the round that was running.
#[async_trait]
pub(crate) trait ToolExecutor<T: Send>: Send {
    async fn execute(
        &mut self,
        call: &ToolCall,
        on_activity: &mut (dyn FnMut(T) + Send),
    ) -> Result<String, CoachError>;
}

/// Where the bounded model loop ended.
#[derive(Debug, PartialEq)]
pub(crate) enum LoopOutcome {
    /// The model answered without asking for more tools. `messages` is the conversation up to
    /// (but not including) this final assistant message, so a caller that runs a follow-up round
    /// can continue from it.
    Answered {
        text: String,
        messages: Vec<Message>,
    },
    /// Ended without a final answer, with the text of the round that was running.
    Failed { error: CoachError, text: String },
}

/// Runs the bounded model loop until the model answers without tool calls, a round or tool fails,
/// the turn is cancelled, or [`MAX_ROUNDS`] rounds are spent.
pub(crate) async fn run<T: Send>(
    rounds: &ModelRounds<'_>,
    mut messages: Vec<Message>,
    executor: &mut dyn ToolExecutor<T>,
    sink: &mut dyn ProgressSink<T>,
) -> LoopOutcome {
    let mut last_text = String::new();
    for round in 0..MAX_ROUNDS {
        if rounds.cancellation.is_cancelled() {
            return LoopOutcome::Failed {
                error: CoachError::Cancelled,
                text: last_text,
            };
        }
        if round > 0 {
            sink.reset();
        }
        let answered = match rounds.ask(&messages, &mut |delta| sink.text(delta)).await {
            Ok(round) => round,
            Err(failure) => {
                return LoopOutcome::Failed {
                    error: failure.error,
                    text: failure.text,
                };
            }
        };
        if answered.tool_calls.is_empty() {
            return LoopOutcome::Answered {
                text: answered.text,
                messages,
            };
        }
        last_text.clone_from(&answered.text);
        let calls = answered.tool_calls.clone();
        messages.push(answered.into_message());
        for (index, call) in calls.iter().enumerate() {
            let content = if index < MAX_TOOL_CALLS_PER_ROUND {
                let outcome = executor
                    .execute(call, &mut |activity| sink.tool(activity))
                    .await;
                match outcome {
                    Ok(content) => {
                        if rounds.cancellation.is_cancelled() {
                            return LoopOutcome::Failed {
                                error: CoachError::Cancelled,
                                text: last_text,
                            };
                        }
                        content
                    }
                    Err(error) => {
                        return LoopOutcome::Failed {
                            error,
                            text: last_text,
                        };
                    }
                }
            } else {
                // Every call needs a result, so the surplus is answered instead of dropped.
                over_the_round_bound()
            };
            messages.push(Message::ToolResult {
                call_id: call.id.clone(),
                content,
            });
        }
    }
    LoopOutcome::Failed {
        error: CoachError::LimitExceeded,
        text: last_text,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::coach::turn::tests::{calls, text, ScriptedBackend};

    #[derive(Default)]
    struct RecordedSink {
        events: Vec<String>,
    }

    impl ProgressSink<String> for RecordedSink {
        fn text(&mut self, delta: &str) {
            self.events.push(format!("text:{delta}"));
        }

        fn reset(&mut self) {
            self.events.push("reset".into());
        }

        fn tool(&mut self, activity: String) {
            self.events.push(format!("tool:{activity}"));
        }
    }

    #[derive(Default)]
    struct EchoExecutor {
        ran: Vec<String>,
        fail_with: Option<CoachError>,
    }

    #[async_trait]
    impl ToolExecutor<String> for EchoExecutor {
        async fn execute(
            &mut self,
            call: &ToolCall,
            on_activity: &mut (dyn FnMut(String) + Send),
        ) -> Result<String, CoachError> {
            self.ran.push(call.id.clone());
            on_activity(call.id.clone());
            if let Some(error) = self.fail_with {
                return Err(error);
            }
            Ok(format!("ok:{}", call.id))
        }
    }

    fn rounds<'a>(
        backend: &'a dyn ModelBackend,
        cancellation: &'a CancellationToken,
    ) -> ModelRounds<'a> {
        ModelRounds {
            backend,
            model: "test-model",
            effort: None,
            system: "test system",
            tools: &[],
            cancellation,
        }
    }

    #[tokio::test]
    async fn rounds_reset_text_and_answer_surplus_calls_without_running_them() {
        let six = vec!["{}"; MAX_TOOL_CALLS_PER_ROUND + 2];
        let backend = ScriptedBackend::new(vec![calls("Checking.", &six), text("Done.")]);
        let cancellation = CancellationToken::new();
        let mut executor = EchoExecutor::default();
        let mut sink = RecordedSink::default();

        let outcome = run(
            &rounds(&backend, &cancellation),
            vec![Message::User("Hi".into())],
            &mut executor,
            &mut sink,
        )
        .await;

        let LoopOutcome::Answered { text, messages } = outcome else {
            panic!("expected answer");
        };
        assert_eq!(text, "Done.");
        assert_eq!(executor.ran.len(), MAX_TOOL_CALLS_PER_ROUND);
        let results: Vec<&str> = messages
            .iter()
            .filter_map(|message| match message {
                Message::ToolResult { content, .. } => Some(content.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(results.len(), six.len());
        assert_eq!(results[0], "ok:call_0");
        assert!(results[MAX_TOOL_CALLS_PER_ROUND].contains("Not run"));
        assert!(results[MAX_TOOL_CALLS_PER_ROUND + 1].contains("Not run"));
        assert_eq!(
            sink.events,
            [
                "text:Checking.",
                "tool:call_0",
                "tool:call_1",
                "tool:call_2",
                "tool:call_3",
                "reset",
                "text:Done.",
            ]
        );
    }

    #[tokio::test]
    async fn hits_round_bound_and_keeps_last_round_text() {
        let script = (0..MAX_ROUNDS)
            .map(|round| calls(&format!("round {round}"), &["{}"]))
            .collect();
        let backend = ScriptedBackend::new(script);
        let cancellation = CancellationToken::new();
        let mut executor = EchoExecutor::default();
        let mut sink = RecordedSink::default();

        let outcome = run(
            &rounds(&backend, &cancellation),
            vec![Message::User("Hi".into())],
            &mut executor,
            &mut sink,
        )
        .await;

        assert_eq!(
            outcome,
            LoopOutcome::Failed {
                error: CoachError::LimitExceeded,
                text: format!("round {}", MAX_ROUNDS - 1),
            }
        );
    }

    #[tokio::test]
    async fn cancellation_and_tool_error_keep_text_so_far() {
        let cancellation = CancellationToken::new();
        let mut backend = ScriptedBackend::new(vec![calls("Working.", &["{}"])]);
        backend.cancel_on_round = Some((0, cancellation.clone()));
        let mut executor = EchoExecutor::default();
        let mut sink = RecordedSink::default();

        let outcome = run(
            &rounds(&backend, &cancellation),
            vec![Message::User("Hi".into())],
            &mut executor,
            &mut sink,
        )
        .await;
        assert_eq!(
            outcome,
            LoopOutcome::Failed {
                error: CoachError::Cancelled,
                text: "Working.".into(),
            }
        );
        assert_eq!(sink.events, ["text:Working.", "tool:call_0"]);

        let backend = ScriptedBackend::new(vec![calls("Before error.", &["{}"])]);
        let mut executor = EchoExecutor {
            fail_with: Some(CoachError::EngineFailed),
            ..Default::default()
        };
        let mut sink = RecordedSink::default();
        let outcome = run(
            &rounds(&backend, &CancellationToken::new()),
            vec![Message::User("Hi".into())],
            &mut executor,
            &mut sink,
        )
        .await;
        assert_eq!(
            outcome,
            LoopOutcome::Failed {
                error: CoachError::EngineFailed,
                text: "Before error.".into(),
            }
        );
    }

    #[tokio::test]
    async fn forwards_model_effort_system_and_tools_to_the_backend() {
        let backend = ScriptedBackend::new(vec![text("Ok.")]);
        let cancellation = CancellationToken::new();
        let tools = [ToolSpec {
            name: "read_topic",
            description: "Reads a help topic.",
            parameters: json!({ "type": "object" }),
        }];
        let model_rounds = ModelRounds {
            backend: &backend,
            model: "assistant-model",
            effort: Some("high"),
            system: "assistant system prompt",
            tools: &tools,
            cancellation: &cancellation,
        };
        let mut executor = EchoExecutor::default();
        let mut sink = RecordedSink::default();

        let outcome = run(
            &model_rounds,
            vec![Message::User("Where is board size?".into())],
            &mut executor,
            &mut sink,
        )
        .await;
        assert!(matches!(outcome, LoopOutcome::Answered { text, .. } if text == "Ok."));
        let seen = backend.seen_round(0);
        assert_eq!(seen.model, "assistant-model");
        assert_eq!(seen.effort.as_deref(), Some("high"));
        assert_eq!(seen.system, "assistant system prompt");
        assert_eq!(seen.tools, ["read_topic"]);
    }

    #[tokio::test]
    async fn cancellation_during_last_round_tool_ends_as_cancelled_not_limit_exceeded() {
        struct CancellingExecutor {
            cancel_on_call: usize,
            calls_seen: usize,
            cancellation: CancellationToken,
        }

        #[async_trait]
        impl ToolExecutor<String> for CancellingExecutor {
            async fn execute(
                &mut self,
                call: &ToolCall,
                on_activity: &mut (dyn FnMut(String) + Send),
            ) -> Result<String, CoachError> {
                self.calls_seen += 1;
                on_activity(call.id.clone());
                if self.calls_seen == self.cancel_on_call {
                    self.cancellation.cancel();
                }
                Ok(format!("ok:{}", call.id))
            }
        }

        let mut script: Vec<_> = (0..MAX_ROUNDS - 1)
            .map(|round| calls(&format!("round {round}"), &["{}"]))
            .collect();
        script.push(calls(&format!("round {}", MAX_ROUNDS - 1), &["{}", "{}"]));
        let backend = ScriptedBackend::new(script);
        let cancellation = CancellationToken::new();
        let mut executor = CancellingExecutor {
            cancel_on_call: MAX_ROUNDS,
            calls_seen: 0,
            cancellation: cancellation.clone(),
        };
        let mut sink = RecordedSink::default();

        let outcome = run(
            &rounds(&backend, &cancellation),
            vec![Message::User("Hi".into())],
            &mut executor,
            &mut sink,
        )
        .await;
        assert_eq!(
            outcome,
            LoopOutcome::Failed {
                error: CoachError::Cancelled,
                text: format!("round {}", MAX_ROUNDS - 1),
            }
        );
        // The second tool call of the last round must not run once the first cancelled the turn.
        assert_eq!(executor.calls_seen, MAX_ROUNDS);
    }

    #[tokio::test]
    async fn pre_cancelled_token_stops_before_the_first_round_with_no_events() {
        let backend = ScriptedBackend::new(Vec::new());
        let cancellation = CancellationToken::new();
        cancellation.cancel();
        let mut executor = EchoExecutor::default();
        let mut sink = RecordedSink::default();

        let outcome = run(
            &rounds(&backend, &cancellation),
            vec![Message::User("Hi".into())],
            &mut executor,
            &mut sink,
        )
        .await;
        assert_eq!(
            outcome,
            LoopOutcome::Failed {
                error: CoachError::Cancelled,
                text: String::new(),
            }
        );
        assert!(sink.events.is_empty());
        assert!(executor.ran.is_empty());
    }
}
