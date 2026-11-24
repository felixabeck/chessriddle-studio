//! Turn driver: batches streamed text, flushes it before a tool notice or the end, enforces the
//! turn deadline, and emits and returns the single terminal update.

use std::time::{Duration, Instant};

use async_trait::async_trait;
use tokio_util::sync::CancellationToken;

use super::{error::CoachError, model_loop::ProgressSink};

/// The longest a turn may take from its first step to its last word.
pub(crate) const TURN_DEADLINE: Duration = Duration::from_secs(300);
/// Streamed text is passed on at most this often, so a fast stream does not flood the renderer.
const TEXT_FLUSH_INTERVAL: Duration = Duration::from_millis(50);

/// How a driven turn ended, before being turned into the caller's terminal update.
#[derive(Debug, PartialEq)]
pub(crate) enum TurnOutcome<A> {
    Completed(A),
    /// Ended without a complete answer, with the text of the round that was running.
    Failed {
        error: CoachError,
        text: String,
    },
}

/// Maps a turn's progress and terminal outcome into the caller's update type and emits each one.
pub(crate) trait UpdateEmitter: Sync {
    type Tool: Send;
    type Answer: Send;
    type Update: Clone + Send;

    fn text(&self, delta: String) -> Self::Update;
    fn reset(&self) -> Self::Update;
    fn tool(&self, activity: Self::Tool) -> Self::Update;
    fn completed(&self, answer: Self::Answer) -> Self::Update;
    fn cancelled(&self, text: String) -> Self::Update;
    fn failed(&self, error: CoachError, text: String) -> Self::Update;
    fn emit(&self, update: Self::Update);
}

/// One turn body executed under [`drive`].
#[async_trait]
pub(crate) trait DrivenTurn<T: Send, A: Send>: Send {
    async fn run(self, sink: &mut dyn ProgressSink<T>) -> TurnOutcome<A>;
}

struct BufferedSink<'a, E: UpdateEmitter> {
    emitter: &'a E,
    /// The text of the running round, for a turn that ends by its deadline.
    text: String,
    pending: String,
    flushed_at: Instant,
    flush_interval: Duration,
}

impl<'a, E: UpdateEmitter> BufferedSink<'a, E> {
    fn new(emitter: &'a E, flush_interval: Duration) -> Self {
        Self {
            emitter,
            text: String::new(),
            pending: String::new(),
            flushed_at: Instant::now(),
            flush_interval,
        }
    }

    fn flush(&mut self) {
        if !self.pending.is_empty() {
            let delta = std::mem::take(&mut self.pending);
            self.emitter.emit(self.emitter.text(delta));
        }
        self.flushed_at = Instant::now();
    }
}

impl<E: UpdateEmitter> ProgressSink<E::Tool> for BufferedSink<'_, E> {
    fn text(&mut self, delta: &str) {
        self.text.push_str(delta);
        self.pending.push_str(delta);
        if self.flushed_at.elapsed() >= self.flush_interval {
            self.flush();
        }
    }

    fn reset(&mut self) {
        self.text.clear();
        self.pending.clear();
        self.emitter.emit(self.emitter.reset());
    }

    fn tool(&mut self, activity: E::Tool) {
        self.flush();
        self.emitter.emit(self.emitter.tool(activity));
    }
}

/// Runs a turn to its end under `deadline` and reports it: progress while it runs, then exactly
/// one terminal update that is both emitted and returned.
pub(crate) async fn drive<E, T>(
    emitter: &E,
    turn: T,
    cancellation: &CancellationToken,
    deadline: Duration,
) -> E::Update
where
    E: UpdateEmitter,
    T: DrivenTurn<E::Tool, E::Answer>,
{
    drive_with_flush(emitter, turn, cancellation, deadline, TEXT_FLUSH_INTERVAL).await
}

async fn drive_with_flush<E, T>(
    emitter: &E,
    turn: T,
    cancellation: &CancellationToken,
    deadline: Duration,
    flush_interval: Duration,
) -> E::Update
where
    E: UpdateEmitter,
    T: DrivenTurn<E::Tool, E::Answer>,
{
    let mut sink = BufferedSink::new(emitter, flush_interval);
    let end = tokio::time::timeout(deadline, turn.run(&mut sink)).await;
    sink.flush();
    let update = match end {
        Ok(TurnOutcome::Completed(answer)) => emitter.completed(answer),
        Ok(TurnOutcome::Failed {
            error: CoachError::Cancelled,
            text,
        }) => emitter.cancelled(text),
        Ok(TurnOutcome::Failed { error, text }) => emitter.failed(error, text),
        Err(_) => {
            // Past the deadline the turn is over for everything that still listens to its token.
            cancellation.cancel();
            emitter.failed(CoachError::LimitExceeded, std::mem::take(&mut sink.text))
        }
    };
    emitter.emit(update.clone());
    update
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[derive(Clone, Debug, PartialEq, Eq)]
    enum Update {
        Text(String),
        Reset,
        Tool(String),
        Completed(String),
        Cancelled(String),
        Failed(CoachError, String),
    }

    #[derive(Default)]
    struct RecordingEmitter {
        seen: Mutex<Vec<Update>>,
    }

    impl RecordingEmitter {
        fn seen(&self) -> Vec<Update> {
            self.seen.lock().unwrap().clone()
        }
    }

    impl UpdateEmitter for RecordingEmitter {
        type Tool = String;
        type Answer = String;
        type Update = Update;

        fn text(&self, delta: String) -> Update {
            Update::Text(delta)
        }

        fn reset(&self) -> Update {
            Update::Reset
        }

        fn tool(&self, activity: String) -> Update {
            Update::Tool(activity)
        }

        fn completed(&self, answer: String) -> Update {
            Update::Completed(answer)
        }

        fn cancelled(&self, text: String) -> Update {
            Update::Cancelled(text)
        }

        fn failed(&self, error: CoachError, text: String) -> Update {
            Update::Failed(error, text)
        }

        fn emit(&self, update: Update) {
            self.seen.lock().unwrap().push(update);
        }
    }

    struct ScriptedTurn(TurnOutcome<String>);

    #[async_trait]
    impl DrivenTurn<String, String> for ScriptedTurn {
        async fn run(self, sink: &mut dyn ProgressSink<String>) -> TurnOutcome<String> {
            sink.text("Part 1 ");
            sink.text("part 2.");
            sink.tool("lookup".into());
            sink.reset();
            sink.text("Final");
            self.0
        }
    }

    #[tokio::test]
    async fn batches_text_flushes_before_tool_and_emits_and_returns_one_terminal_update() {
        let emitter = RecordingEmitter::default();
        let returned = drive_with_flush(
            &emitter,
            ScriptedTurn(TurnOutcome::Completed("Final".into())),
            &CancellationToken::new(),
            Duration::from_secs(5),
            Duration::from_secs(60),
        )
        .await;

        let expected_terminal = Update::Completed("Final".into());
        assert_eq!(returned, expected_terminal);
        assert_eq!(
            emitter.seen(),
            [
                Update::Text("Part 1 part 2.".into()),
                Update::Tool("lookup".into()),
                Update::Reset,
                Update::Text("Final".into()),
                expected_terminal,
            ]
        );
    }

    struct StalledTurn;

    #[async_trait]
    impl DrivenTurn<String, String> for StalledTurn {
        async fn run(self, sink: &mut dyn ProgressSink<String>) -> TurnOutcome<String> {
            sink.text("So far");
            std::future::pending().await
        }
    }

    #[tokio::test]
    async fn deadline_cancels_token_and_keeps_text_so_far() {
        let emitter = RecordingEmitter::default();
        let cancellation = CancellationToken::new();
        let returned = drive(
            &emitter,
            StalledTurn,
            &cancellation,
            Duration::from_millis(30),
        )
        .await;

        let expected = Update::Failed(CoachError::LimitExceeded, "So far".into());
        assert_eq!(returned, expected);
        assert_eq!(emitter.seen(), [Update::Text("So far".into()), expected]);
        assert!(cancellation.is_cancelled());
    }

    #[tokio::test]
    async fn cancelled_and_failed_outcomes_map_to_their_own_terminal_update() {
        for (outcome, expected) in [
            (
                TurnOutcome::Failed {
                    error: CoachError::Cancelled,
                    text: "Half".into(),
                },
                Update::Cancelled("Half".into()),
            ),
            (
                TurnOutcome::Failed {
                    error: CoachError::RateLimited,
                    text: "Half".into(),
                },
                Update::Failed(CoachError::RateLimited, "Half".into()),
            ),
        ] {
            let emitter = RecordingEmitter::default();
            struct Immediate(TurnOutcome<String>);
            #[async_trait]
            impl DrivenTurn<String, String> for Immediate {
                async fn run(self, _sink: &mut dyn ProgressSink<String>) -> TurnOutcome<String> {
                    self.0
                }
            }
            let returned = drive(
                &emitter,
                Immediate(outcome),
                &CancellationToken::new(),
                Duration::from_secs(5),
            )
            .await;
            assert_eq!(returned, expected);
            assert_eq!(emitter.seen(), [expected]);
        }
    }

    #[tokio::test]
    async fn reset_clears_buffered_text_for_both_completed_and_deadline_turns() {
        struct ResetThenComplete;

        #[async_trait]
        impl DrivenTurn<String, String> for ResetThenComplete {
            async fn run(self, sink: &mut dyn ProgressSink<String>) -> TurnOutcome<String> {
                sink.text("Stale");
                sink.reset();
                sink.text("Fresh");
                TurnOutcome::Completed("Fresh".into())
            }
        }

        let emitter = RecordingEmitter::default();
        let returned = drive_with_flush(
            &emitter,
            ResetThenComplete,
            &CancellationToken::new(),
            Duration::from_secs(5),
            Duration::from_secs(60),
        )
        .await;
        let expected = Update::Completed("Fresh".into());
        assert_eq!(returned, expected);
        assert_eq!(
            emitter.seen(),
            [Update::Reset, Update::Text("Fresh".into()), expected]
        );

        struct ResetThenStall;

        #[async_trait]
        impl DrivenTurn<String, String> for ResetThenStall {
            async fn run(self, sink: &mut dyn ProgressSink<String>) -> TurnOutcome<String> {
                sink.text("Stale");
                sink.reset();
                sink.text("Fresh");
                std::future::pending().await
            }
        }

        let emitter = RecordingEmitter::default();
        let cancellation = CancellationToken::new();
        let returned = drive_with_flush(
            &emitter,
            ResetThenStall,
            &cancellation,
            Duration::from_millis(30),
            Duration::from_secs(60),
        )
        .await;
        let expected = Update::Failed(CoachError::LimitExceeded, "Fresh".into());
        assert_eq!(returned, expected);
        assert_eq!(
            emitter.seen(),
            [Update::Reset, Update::Text("Fresh".into()), expected]
        );
        assert!(cancellation.is_cancelled());
    }

    #[tokio::test]
    async fn flushes_text_in_batches_once_the_flush_interval_elapses() {
        struct SpacedText;

        #[async_trait]
        impl DrivenTurn<String, String> for SpacedText {
            async fn run(self, sink: &mut dyn ProgressSink<String>) -> TurnOutcome<String> {
                sink.text("First ");
                tokio::time::sleep(Duration::from_millis(220)).await;
                sink.text("second.");
                // Both following deltas arrive well inside the new flush interval and must batch.
                sink.text(" Third.");
                sink.text(" Fourth.");
                TurnOutcome::Completed("done".into())
            }
        }

        let emitter = RecordingEmitter::default();
        let returned = drive_with_flush(
            &emitter,
            SpacedText,
            &CancellationToken::new(),
            Duration::from_secs(5),
            Duration::from_millis(200),
        )
        .await;
        let expected = Update::Completed("done".into());
        assert_eq!(returned, expected);
        assert_eq!(
            emitter.seen(),
            [
                Update::Text("First second.".into()),
                Update::Text(" Third. Fourth.".into()),
                expected,
            ]
        );
    }
}
