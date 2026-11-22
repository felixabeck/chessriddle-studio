//! The sign-in attempts that run now.
//!
//! A sign-in waits for a person in a browser, so it can outlive what started it. This holder owns
//! every attempt from its start to its end: at most one per kind of sign-in, each with the id the
//! renderer gave it, the window that started it and a cancellation token. An attempt is ended by
//! its own result, by the user's cancel (by id), by a new attempt of the same kind (which waits
//! until the old one is gone), by the end of its window or of that window's document, and by the
//! application's exit. Its entry is removed on every one of these ways.

use std::{
    collections::HashMap,
    future::Future,
    sync::{Arc, Mutex, PoisonError},
};

use tokio_util::sync::CancellationToken;

use super::error::CoachError;

const MAX_ATTEMPT_ID_CHARS: usize = 64;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) enum SignInKind {
    ChatGpt,
    Grok,
}

/// Whether `id` can name an attempt: short, and without control characters.
pub(crate) fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.chars().count() <= MAX_ATTEMPT_ID_CHARS
        && !id.chars().any(char::is_control)
}

struct Attempt {
    id: String,
    window: String,
    cancellation: CancellationToken,
    /// Cancelled when the attempt is over and its entry is gone.
    finished: CancellationToken,
}

#[derive(Default)]
pub(crate) struct SignInAttempts {
    active: Mutex<HashMap<SignInKind, Attempt>>,
}

/// Removes an attempt's entry and tells everyone waiting for it, however the attempt ends.
struct Entry {
    attempts: Arc<SignInAttempts>,
    kind: SignInKind,
    finished: CancellationToken,
}

impl Drop for Entry {
    fn drop(&mut self) {
        self.attempts
            .active
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&self.kind);
        self.finished.cancel();
    }
}

impl SignInAttempts {
    fn active(&self) -> std::sync::MutexGuard<'_, HashMap<SignInKind, Attempt>> {
        self.active.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Runs `work` as the one attempt of its kind and returns its result. An attempt of the same
    /// kind that still runs is cancelled and waited for first. `work` is given the token that
    /// ends it; an attempt that was cancelled ends as `cancelled` whatever `work` returned.
    pub(crate) async fn run<T, F, Fut>(
        self: &Arc<Self>,
        kind: SignInKind,
        id: &str,
        window: &str,
        work: F,
    ) -> Result<T, CoachError>
    where
        F: FnOnce(CancellationToken) -> Fut,
        Fut: Future<Output = Result<T, CoachError>>,
    {
        if !valid_id(id) {
            return Err(CoachError::InvalidInput);
        }
        let cancellation = CancellationToken::new();
        let finished = CancellationToken::new();
        loop {
            // Looked at and entered under one lock, so two new attempts cannot both get in.
            let previous = {
                let mut active = self.active();
                match active.get(&kind) {
                    Some(previous) => {
                        previous.cancellation.cancel();
                        Some(previous.finished.clone())
                    }
                    None => {
                        active.insert(
                            kind,
                            Attempt {
                                id: id.to_owned(),
                                window: window.to_owned(),
                                cancellation: cancellation.clone(),
                                finished: finished.clone(),
                            },
                        );
                        None
                    }
                }
            };
            match previous {
                Some(previous) => previous.cancelled().await,
                None => break,
            }
        }
        let entry = Entry {
            attempts: Arc::clone(self),
            kind,
            finished,
        };
        let result = work(cancellation.clone()).await;
        drop(entry);
        match result {
            Ok(value) => Ok(value),
            Err(_) if cancellation.is_cancelled() => Err(CoachError::Cancelled),
            Err(error) => Err(error),
        }
    }

    /// Ends the attempt with this id, if it still runs.
    pub(crate) fn cancel(&self, id: &str) {
        for attempt in self.active().values().filter(|attempt| attempt.id == id) {
            attempt.cancellation.cancel();
        }
    }

    /// Ends the attempts a window started: the window was destroyed, or its document replaced.
    pub(crate) fn cancel_window(&self, window: &str) {
        for attempt in self
            .active()
            .values()
            .filter(|attempt| attempt.window == window)
        {
            attempt.cancellation.cancel();
        }
    }

    /// Ends every attempt and waits until each is gone. The caller bounds the wait.
    pub(crate) async fn shutdown(&self) {
        let waiting: Vec<CancellationToken> = self
            .active()
            .values()
            .map(|attempt| {
                attempt.cancellation.cancel();
                attempt.finished.clone()
            })
            .collect();
        for finished in waiting {
            finished.cancelled().await;
        }
    }

    #[cfg(test)]
    pub(crate) fn is_idle(&self) -> bool {
        self.active().is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    /// An attempt that waits for its cancellation, like a sign-in whose user never comes back.
    async fn waiting(
        attempts: Arc<SignInAttempts>,
        id: &'static str,
        window: &'static str,
        started: tokio::sync::mpsc::UnboundedSender<&'static str>,
    ) -> Result<&'static str, CoachError> {
        attempts
            .run(SignInKind::ChatGpt, id, window, |cancellation| async move {
                started.send(id).unwrap();
                cancellation.cancelled().await;
                // What a cancelled sign-in reports is replaced by `cancelled`.
                Err(CoachError::SignInFailed)
            })
            .await
    }

    async fn within<T>(future: impl Future<Output = T>) -> T {
        tokio::time::timeout(Duration::from_secs(5), future)
            .await
            .expect("the attempt ends")
    }

    #[tokio::test]
    async fn an_attempt_returns_its_result_and_leaves_no_entry() {
        let attempts = Arc::new(SignInAttempts::default());
        let done = attempts
            .run(SignInKind::ChatGpt, "a", "main", |_| async { Ok(7) })
            .await;
        assert_eq!(done, Ok(7));
        assert!(attempts.is_idle());
        let failed: Result<(), _> = attempts
            .run(SignInKind::ChatGpt, "b", "main", |_| async {
                Err(CoachError::Network)
            })
            .await;
        assert_eq!(failed, Err(CoachError::Network));
        assert!(attempts.is_idle());
        for id in ["", "x\ny", &"i".repeat(MAX_ATTEMPT_ID_CHARS + 1)] {
            let refused: Result<(), _> = attempts
                .run(SignInKind::ChatGpt, id, "main", |_| async {
                    panic!("an attempt without a usable id never starts")
                })
                .await;
            assert_eq!(refused, Err(CoachError::InvalidInput));
        }
    }

    #[tokio::test]
    async fn cancel_by_id_ends_that_attempt_and_no_other() {
        let attempts = Arc::new(SignInAttempts::default());
        let (started, mut starts) = tokio::sync::mpsc::unbounded_channel();
        let running = tokio::spawn(waiting(attempts.clone(), "first", "main", started));
        assert_eq!(starts.recv().await, Some("first"));
        attempts.cancel("another");
        assert!(!attempts.is_idle());
        attempts.cancel("first");
        assert_eq!(within(running).await.unwrap(), Err(CoachError::Cancelled));
        assert!(attempts.is_idle());
    }

    #[tokio::test]
    async fn a_new_attempt_ends_the_one_before_it_and_starts_only_when_that_is_gone() {
        let attempts = Arc::new(SignInAttempts::default());
        let (started, mut starts) = tokio::sync::mpsc::unbounded_channel();
        let first = tokio::spawn(waiting(attempts.clone(), "first", "main", started.clone()));
        assert_eq!(starts.recv().await, Some("first"));
        let second = tokio::spawn(waiting(attempts.clone(), "second", "main", started));
        assert_eq!(within(first).await.unwrap(), Err(CoachError::Cancelled));
        assert_eq!(within(starts.recv()).await, Some("second"));
        // The first one's cancel does not reach its successor.
        attempts.cancel("first");
        assert!(!attempts.is_idle());
        attempts.cancel("second");
        assert_eq!(within(second).await.unwrap(), Err(CoachError::Cancelled));
        assert!(attempts.is_idle());
    }

    #[tokio::test]
    async fn the_end_of_its_window_ends_an_attempt_and_shutdown_waits_for_all() {
        let attempts = Arc::new(SignInAttempts::default());
        let (started, mut starts) = tokio::sync::mpsc::unbounded_channel();
        let running = tokio::spawn(waiting(
            attempts.clone(),
            "first",
            "report",
            started.clone(),
        ));
        assert_eq!(starts.recv().await, Some("first"));
        attempts.cancel_window("main");
        assert!(!attempts.is_idle());
        attempts.cancel_window("report");
        assert_eq!(within(running).await.unwrap(), Err(CoachError::Cancelled));

        let running = tokio::spawn(waiting(attempts.clone(), "second", "main", started));
        assert_eq!(starts.recv().await, Some("second"));
        within(attempts.shutdown()).await;
        // Shutdown returned only after the attempt's entry was gone.
        assert!(attempts.is_idle());
        assert_eq!(within(running).await.unwrap(), Err(CoachError::Cancelled));
        // With nothing running it returns at once.
        within(attempts.shutdown()).await;
    }

    #[tokio::test]
    async fn sign_ins_of_different_kinds_run_side_by_side() {
        let attempts = Arc::new(SignInAttempts::default());
        let (started, mut starts) = tokio::sync::mpsc::unbounded_channel();
        let chatgpt = tokio::spawn(waiting(attempts.clone(), "chatgpt", "main", started));
        assert_eq!(starts.recv().await, Some("chatgpt"));
        let grok = attempts
            .run(SignInKind::Grok, "grok", "main", |_| async { Ok(()) })
            .await;
        assert_eq!(grok, Ok(()));
        // The other kind's attempt was not ended by it.
        assert!(!attempts.is_idle());
        attempts.cancel("chatgpt");
        assert_eq!(within(chatgpt).await.unwrap(), Err(CoachError::Cancelled));
    }

    #[tokio::test]
    async fn an_attempt_that_is_dropped_midway_frees_its_place() {
        let attempts = Arc::new(SignInAttempts::default());
        let (started, mut starts) = tokio::sync::mpsc::unbounded_channel();
        let running = tokio::spawn(waiting(attempts.clone(), "first", "main", started.clone()));
        assert_eq!(starts.recv().await, Some("first"));
        running.abort();
        let _ = running.await;
        assert!(attempts.is_idle());
        let next = attempts
            .run(SignInKind::ChatGpt, "next", "main", |_| async { Ok(()) })
            .await;
        assert_eq!(next, Ok(()));
    }
}
