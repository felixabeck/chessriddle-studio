//! Deterministic `UciIo` doubles shared by the process tests and the `#[cfg(test)]` actor constructors.

use super::*;

#[cfg(test)]
pub(super) struct ReadObservation {
    pub(super) started: Option<Arc<AtomicBool>>,
    pub(super) attempts: Option<Arc<std::sync::atomic::AtomicUsize>>,
}

#[cfg(test)]
pub(super) struct FakeIo {
    pub(super) writes: Arc<Mutex<Vec<String>>>,
    pub(super) write_completions: Arc<Mutex<Vec<(String, Instant)>>>,
    pub(super) write_delays: Vec<(String, Duration)>,
    pub(super) lines: VecDeque<(Duration, Option<String>)>,
    pub(super) endless_line: Option<String>,
    pub(super) read_interval: Duration,
    pub(super) pending_when_empty: bool,
    pub(super) terminate_calls: Arc<std::sync::atomic::AtomicUsize>,
    pub(super) fail_write: bool,
    pub(super) fail_stop: bool,
    pub(super) read_delay: Option<Duration>,
    pub(super) read_observation: Option<ReadObservation>,
    pub(super) terminate_delay: Option<Duration>,
    pub(super) terminate_started: Option<Arc<AtomicBool>>,
    pub(super) cancel_after_write: Option<(String, Arc<AtomicBool>)>,
    pub(super) exchange_observation: Option<(ExchangePoint, oneshot::Sender<()>)>,
    pub(super) blocked_write: Option<String>,
    pub(super) termination_error: Option<Arc<Error>>,
    pub(super) termination_gate: Option<Arc<TerminationReplyGate>>,
}

#[cfg(test)]
#[derive(Clone)]
pub(super) enum ExchangePoint {
    Write(String),
    ReadAfter(String),
}

#[cfg(test)]
impl FakeIo {
    pub(super) fn new(
        writes: Arc<Mutex<Vec<String>>>,
        lines: impl IntoIterator<Item = Option<String>>,
    ) -> Self {
        Self {
            writes,
            write_completions: Arc::new(Mutex::new(Vec::new())),
            write_delays: Vec::new(),
            lines: lines
                .into_iter()
                .map(|line| (Duration::ZERO, line))
                .collect(),
            endless_line: None,
            read_interval: Duration::ZERO,
            pending_when_empty: false,
            terminate_calls: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
            fail_write: false,
            fail_stop: false,
            read_delay: None,
            read_observation: None,
            terminate_delay: None,
            terminate_started: None,
            cancel_after_write: None,
            exchange_observation: None,
            blocked_write: None,
            termination_error: None,
            termination_gate: None,
        }
    }
}

#[cfg(test)]
#[async_trait]
impl UciIo for FakeIo {
    async fn write_line(&mut self, line: &str) -> Result<(), Error> {
        if matches!(&self.exchange_observation, Some((ExchangePoint::Write(command), _)) if command == line)
        {
            if let Some((_, started)) = self.exchange_observation.take() {
                let _ = started.send(());
            }
        }
        if self.blocked_write.as_deref() == Some(line) {
            return std::future::pending().await;
        }
        if self.fail_write || (self.fail_stop && line == "stop") {
            return Err(
                std::io::Error::new(std::io::ErrorKind::BrokenPipe, "fake stdin closed").into(),
            );
        }
        if let Some(index) = self
            .write_delays
            .iter()
            .position(|(command, _)| command == line)
        {
            let (_, delay) = self.write_delays.remove(index);
            tokio::time::sleep(delay).await;
        }
        self.writes.lock().await.push(line.into());
        self.write_completions
            .lock()
            .await
            .push((line.into(), Instant::now()));
        if let Some((command, cancelled)) = &self.cancel_after_write {
            if command == line {
                cancelled.store(true, Ordering::SeqCst);
            }
        }
        Ok(())
    }

    async fn read_line(&mut self) -> Result<Option<String>, Error> {
        if self.lines.is_empty() {
            let observed = match &self.exchange_observation {
                Some((ExchangePoint::ReadAfter(command), _)) => {
                    self.writes
                        .lock()
                        .await
                        .last()
                        .map(String::as_str)
                        .unwrap_or("")
                        == command
                }
                _ => false,
            };
            if observed {
                if let Some((_, started)) = self.exchange_observation.take() {
                    let _ = started.send(());
                }
            }
        }
        if let Some(observation) = &self.read_observation {
            if let Some(started) = &observation.started {
                started.store(true, Ordering::SeqCst);
            }
            if let Some(attempts) = &observation.attempts {
                attempts.fetch_add(1, Ordering::SeqCst);
            }
        }
        if let Some(delay) = self.read_delay.take() {
            tokio::time::sleep(delay).await;
        }
        if let Some((delay, line)) = self.lines.pop_front() {
            if !delay.is_zero() {
                tokio::time::sleep(delay).await;
            }
            return Ok(line);
        }
        if let Some(line) = &self.endless_line {
            tokio::time::sleep(self.read_interval).await;
            return Ok(Some(line.clone()));
        }
        if self.pending_when_empty {
            return std::future::pending::<Result<Option<String>, Error>>().await;
        }
        Ok(None)
    }

    async fn terminate(&mut self, _: Duration, _: Duration) -> Result<(), Error> {
        if let Some(gate) = &self.termination_gate {
            gate.park().await;
        }
        if let Some(started) = &self.terminate_started {
            started.store(true, Ordering::SeqCst);
        }
        if let Some(delay) = self.terminate_delay {
            tokio::time::sleep(delay).await;
        }
        self.terminate_calls.fetch_add(1, Ordering::SeqCst);
        if self.termination_error.is_none() {
            // A reaped child cannot produce more output. Buffered lines remain
            // readable, then the pipe reaches EOF as production IO does.
            self.endless_line = None;
            self.pending_when_empty = false;
        }
        self.termination_error
            .clone()
            .map_or(Ok(()), |error| Err(Error::Shared(error)))
    }
}
#[cfg(test)]
pub(super) struct GameCleanupTestIo {
    pub(super) started: Arc<AtomicBool>,
    pub(super) delay: Option<Duration>,
    pub(super) error: Option<String>,
}

#[cfg(test)]
#[async_trait]
impl UciIo for GameCleanupTestIo {
    async fn write_line(&mut self, _: &str) -> Result<(), Error> {
        Ok(())
    }

    async fn read_line(&mut self) -> Result<Option<String>, Error> {
        std::future::pending().await
    }

    async fn terminate(&mut self, _: Duration, _: Duration) -> Result<(), Error> {
        self.started.store(true, Ordering::SeqCst);
        if let Some(delay) = self.delay {
            tokio::time::sleep(delay).await;
        }
        match &self.error {
            Some(error) => Err(std::io::Error::other(error.clone()).into()),
            None => Ok(()),
        }
    }
}
