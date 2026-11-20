//! UCI I/O over the engine child process: bounded line reads, stderr draining, child ownership, termination and force-kill/reap.

use super::*;

/// The minimal child-process surface used by the actor.  The production
/// implementation owns every child handle; deterministic tests can provide a
/// fake without creating or killing OS processes.
#[async_trait]
pub trait UciIo: Send {
    fn observed_exit(&self) -> Option<EngineExitStatus> {
        None
    }
    async fn write_line(&mut self, line: &str) -> Result<(), Error>;
    async fn read_line(&mut self) -> Result<Option<String>, Error>;
    fn is_discarding_line(&self) -> bool {
        false
    }
    async fn discard_line_remainder(&mut self) -> Result<(), Error> {
        Ok(())
    }
    async fn terminate(
        &mut self,
        quit_timeout: Duration,
        kill_reap_timeout: Duration,
    ) -> Result<(), Error>;
}
pub(super) struct ResumableLineReader<R> {
    pub(super) reader: R,
    pub(super) pending_line: Vec<u8>,
    pub(super) discarding_line: bool,
}

impl<R: AsyncBufRead + Unpin> ResumableLineReader<R> {
    pub(super) fn new(reader: R) -> Self {
        Self {
            reader,
            pending_line: Vec::new(),
            discarding_line: false,
        }
    }

    pub(super) async fn read_line(&mut self) -> Result<Option<String>, Error> {
        let result = read_bounded_engine_line(&mut self.reader, &mut self.pending_line).await;
        self.discarding_line = matches!(result, Err(Error::ResourceLimit(_)));
        result
    }

    pub(super) fn is_discarding_line(&self) -> bool {
        self.discarding_line
    }

    pub(super) async fn discard_line_remainder(&mut self) -> std::io::Result<()> {
        if self.discarding_line || !self.pending_line.is_empty() {
            self.discarding_line = true;
            self.pending_line.clear();
            discard_engine_line_remainder(&mut self.reader).await?;
            self.discarding_line = false;
        }
        Ok(())
    }
}

pub(super) struct ChildUciIo {
    pub(super) cleanup: Arc<ChildOwner>,
    pub(super) line_reader: ResumableLineReader<BufReader<ChildStdout>>,
    pub(super) observed_exit: Arc<OnceLock<EngineExitStatus>>,
}

pub(super) const MAX_OWNED_CHILDREN: usize = 4096;

/// Cleanup authority survives protocol task exit. A lease moves the handle out
/// of the mutex and restores it on cancellation, without locking across IO.
#[derive(Default)]
pub(super) struct ChildOwner {
    pub(super) state: StdMutex<ChildOwnership>,
}

#[derive(Default)]
pub(super) struct ChildOwnership {
    pub(super) control: Option<Box<dyn ChildControl>>,
    // Keep the validated executable, cwd and resource descriptors until confirmed
    // reaping. Linux executes the sealed target through `/proc/self/fd/N`.
    pub(super) executable: Option<EngineExecutable>,
    pub(super) slot: Option<OwnedSemaphorePermit>,
    pub(super) leased: bool,
}

pub(super) struct ChildLease<'a> {
    pub(super) owner: &'a ChildOwner,
    pub(super) control: Option<Box<dyn ChildControl>>,
    pub(super) reaped: bool,
}

impl Drop for ChildLease<'_> {
    fn drop(&mut self) {
        let mut state = self.owner.state.lock().unwrap_or_else(|e| e.into_inner());
        state.leased = false;
        if self.reaped {
            state.executable.take();
            state.slot.take();
        } else {
            state.control = self.control.take();
        }
    }
}

impl ChildOwner {
    pub(super) fn lease(&self) -> Result<ChildLease<'_>, Error> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.leased {
            return Err(Error::Conflict("engine cleanup is in progress".into()));
        }
        state.leased = true;
        Ok(ChildLease {
            owner: self,
            control: state.control.take(),
            reaped: false,
        })
    }

    pub(super) fn unresolved(&self) -> bool {
        let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.leased || state.control.is_some()
    }

    pub(super) async fn terminate(
        &self,
        quit: Duration,
        reap: Duration,
        graceful: bool,
    ) -> Result<(), Error> {
        let mut lease = self.lease()?;
        let result = match lease.control.as_mut() {
            Some(control) if graceful => terminate_child(control.as_mut(), quit, reap).await,
            Some(control) => map_force_kill_and_reap(
                &Error::EngineDisconnected,
                force_kill_and_reap(control.as_mut(), reap).await,
                ReapTimeoutPolicy::EngineTimeout,
            ),
            None => Ok(()),
        };
        lease.reaped = result.is_ok();
        result
    }
}

pub(super) struct ProcessChildControl {
    pub(super) stdin: Option<ChildStdin>,
    pub(super) child: Child,
    pub(super) observed_exit: Arc<OnceLock<EngineExitStatus>>,
    pub(super) kill_started: bool,
    #[cfg(all(test, unix))]
    pub(super) terminate_failure: Option<TerminateFailure>,
    #[cfg(all(test, unix))]
    pub(super) force_kill_started: bool,
}

#[async_trait]
pub(super) trait ChildCleanup: Send {
    fn start_kill(&mut self) -> Result<(), Error>;
    async fn wait(&mut self) -> Result<(), Error>;
    #[cfg(all(test, unix))]
    fn clear_failure(&mut self) {}
}

#[async_trait]
pub(super) trait ChildControl: ChildCleanup {
    async fn write_quit(&mut self) -> Result<(), Error>;
    async fn write_line(&mut self, _line: &str) -> Result<(), Error> {
        Err(Error::EngineDisconnected)
    }
}

#[async_trait]
impl ChildCleanup for ProcessChildControl {
    #[cfg(all(test, unix))]
    fn clear_failure(&mut self) {
        self.terminate_failure = None;
    }
    fn start_kill(&mut self) -> Result<(), Error> {
        self.kill_started = true;
        #[cfg(all(test, unix))]
        if matches!(self.terminate_failure, Some(TerminateFailure::QuitKillReap)) {
            self.force_kill_started = true;
            return match self.child.start_kill() {
                Ok(()) => Err(std::io::Error::other("injected engine kill failure").into()),
                Err(error) => Err(error.into()),
            };
        }
        self.child.start_kill().map_err(Into::into)
    }

    async fn wait(&mut self) -> Result<(), Error> {
        #[cfg(all(test, unix))]
        if self.terminate_failure == Some(TerminateFailure::ReapError) {
            self.child.wait().await?;
            return Err(Error::Conflict("injected engine reap failure".into()));
        }
        #[cfg(all(test, unix))]
        if self.terminate_failure == Some(TerminateFailure::ReapTimeout) {
            std::future::pending::<()>().await;
        }
        #[cfg(all(test, unix))]
        if self.terminate_failure == Some(TerminateFailure::QuitKillReap)
            && !self.force_kill_started
        {
            return Err(Error::Conflict("injected engine reap failure".into()));
        }
        #[cfg(all(test, unix))]
        if self.terminate_failure == Some(TerminateFailure::QuitKillReap) {
            self.child.wait().await?;
            return Err(Error::Conflict("injected engine reap failure".into()));
        }
        let status = self.child.wait().await?;
        if !self.kill_started {
            let _ = self.observed_exit.set(observed_exit_status(status));
        }
        Ok(())
    }
}

pub(super) fn observed_exit_status(status: std::process::ExitStatus) -> EngineExitStatus {
    #[cfg(unix)]
    let signal = {
        use std::os::unix::process::ExitStatusExt;
        status.signal()
    };
    #[cfg(not(unix))]
    let signal = None;
    EngineExitStatus {
        code: status.code(),
        signal,
    }
}

#[async_trait]
impl ChildControl for ProcessChildControl {
    async fn write_quit(&mut self) -> Result<(), Error> {
        #[cfg(all(test, unix))]
        if matches!(self.terminate_failure, Some(TerminateFailure::QuitKillReap)) {
            return Err(Error::Conflict("injected engine quit failure".into()));
        }
        self.write_line("quit").await
    }

    async fn write_line(&mut self, line: &str) -> Result<(), Error> {
        let stdin = self.stdin.as_mut().ok_or(Error::NoStdin)?;
        stdin.write_all(line.as_bytes()).await?;
        stdin.write_all(b"\n").await?;
        stdin.flush().await?;
        Ok(())
    }
}

pub(super) enum ForceKillAndReap {
    Reaped,
    ReapFailed {
        kill_error: Option<Error>,
        reap_error: Error,
    },
    ReapTimedOut {
        kill_error: Option<Error>,
        timeout: Duration,
    },
}

pub(super) enum ReapTimeoutPolicy {
    EngineTimeout,
    #[cfg(test)]
    OperationAndCleanup,
}

pub(super) fn map_force_kill_and_reap(
    primary: &Error,
    result: ForceKillAndReap,
    timeout_policy: ReapTimeoutPolicy,
) -> Result<(), Error> {
    match result {
        ForceKillAndReap::Reaped => Ok(()),
        ForceKillAndReap::ReapFailed {
            kill_error: Some(kill),
            reap_error: reap,
        } => Err(Error::OperationAndCleanup {
            primary: primary.diagnostic(),
            cleanup: format!(
                "force-kill failed: {}; final reap failed: {}",
                kill.diagnostic(),
                reap.diagnostic()
            ),
        }),
        ForceKillAndReap::ReapFailed {
            kill_error: None,
            reap_error: reap,
        } => Err(Error::OperationAndCleanup {
            primary: primary.diagnostic(),
            cleanup: format!("final reap failed: {}", reap.diagnostic()),
        }),
        ForceKillAndReap::ReapTimedOut {
            kill_error: Some(kill),
            timeout,
        } => Err(Error::OperationAndCleanup {
            primary: primary.diagnostic(),
            cleanup: format!(
                "force-kill failed: {}; final reap exceeded {timeout:?}",
                kill.diagnostic()
            ),
        }),
        ForceKillAndReap::ReapTimedOut {
            kill_error: None,
            timeout,
        } => match timeout_policy {
            ReapTimeoutPolicy::EngineTimeout => Err(Error::EngineTimeout(format!(
                "waiting for engine reap after force-kill exceeded {timeout:?}"
            ))),
            #[cfg(test)]
            ReapTimeoutPolicy::OperationAndCleanup => Err(Error::OperationAndCleanup {
                primary: primary.diagnostic(),
                cleanup: format!("final reap exceeded {timeout:?}"),
            }),
        },
    }
}

pub(super) async fn force_kill_and_reap<C: ChildCleanup + ?Sized>(
    child: &mut C,
    kill_reap_timeout: Duration,
) -> ForceKillAndReap {
    let kill_error = child.start_kill().err();
    let reap = timeout(kill_reap_timeout, child.wait()).await;
    match reap {
        Ok(Ok(())) => {
            if let Some(kill) = kill_error.as_ref() {
                error!(
                    "engine force-kill reported an error but child reaped: {}",
                    kill.diagnostic()
                );
            }
            ForceKillAndReap::Reaped
        }
        Ok(Err(reap_error)) => ForceKillAndReap::ReapFailed {
            kill_error,
            reap_error,
        },
        Err(_) => ForceKillAndReap::ReapTimedOut {
            kill_error,
            timeout: kill_reap_timeout,
        },
    }
}

pub(super) async fn terminate_child<C: ChildControl + ?Sized>(
    child: &mut C,
    quit_timeout: Duration,
    kill_reap_timeout: Duration,
) -> Result<(), Error> {
    let graceful_deadline = tokio::time::Instant::now() + quit_timeout;
    let quit = tokio::time::timeout_at(graceful_deadline, child.write_quit())
        .await
        .map_err(|_| Error::EngineTimeout("writing quit to engine".into()))
        .and_then(|result| result);
    let graceful_wait = tokio::time::timeout_at(graceful_deadline, child.wait()).await;
    if matches!(graceful_wait, Ok(Ok(()))) {
        if let Err(error) = quit {
            error!(
                "engine quit write failed after child exited: {}",
                error.diagnostic()
            );
        }
        return Ok(());
    }

    let primary = match (quit, graceful_wait) {
        (Err(error), _) => error,
        (Ok(()), Ok(Err(error))) => error,
        (Ok(()), Err(_)) => Error::EngineTimeout("waiting for engine exit".into()),
        (Ok(()), Ok(Ok(()))) => return Ok(()),
    };
    match map_force_kill_and_reap(
        &primary,
        force_kill_and_reap(child, kill_reap_timeout).await,
        ReapTimeoutPolicy::EngineTimeout,
    ) {
        Ok(()) => {
            error!(
                "engine graceful shutdown failed but child reaped: {}",
                primary.diagnostic()
            );
            Ok(())
        }
        Err(error) => Err(error),
    }
}

pub(super) async fn read_bounded_engine_line<R: AsyncBufRead + Unpin>(
    reader: &mut R,
    pending_line: &mut Vec<u8>,
) -> Result<Option<String>, Error> {
    loop {
        let (take, ended) = {
            let available = match reader.fill_buf().await {
                Ok(available) => available,
                Err(error) => {
                    return Err(error.into());
                }
            };
            if available.is_empty() {
                return if pending_line.is_empty() {
                    Ok(None)
                } else {
                    String::from_utf8(std::mem::take(pending_line))
                        .map(Some)
                        .map_err(|_| Error::InvalidInput("engine emitted non-UTF-8 output".into()))
                };
            }

            let take = available
                .iter()
                .position(|byte| *byte == b'\n')
                .map(|index| index + 1)
                .unwrap_or(available.len());
            if pending_line.len().saturating_add(take) > MAX_ENGINE_LINE_BYTES {
                // The caller treats this as a protocol failure and terminates
                // the child; do not consume an unbounded remainder first.
                pending_line.clear();
                return Err(Error::ResourceLimit(format!(
                    "engine emitted a line larger than {MAX_ENGINE_LINE_BYTES} bytes"
                )));
            }
            pending_line.extend_from_slice(&available[..take]);
            (take, available[take - 1] == b'\n')
        };
        reader.consume(take);
        if ended {
            if pending_line.last() == Some(&b'\n') {
                pending_line.pop();
            }
            if pending_line.last() == Some(&b'\r') {
                pending_line.pop();
            }
            return String::from_utf8(std::mem::take(pending_line))
                .map(Some)
                .map_err(|_| Error::InvalidInput("engine emitted non-UTF-8 output".into()));
        }
    }
}

pub(super) async fn discard_engine_line_remainder<R: AsyncBufRead + Unpin>(
    reader: &mut R,
) -> std::io::Result<()> {
    loop {
        let (consumed, ended) = {
            let available = reader.fill_buf().await?;
            if available.is_empty() {
                return Ok(());
            }
            match available.iter().position(|byte| *byte == b'\n') {
                Some(index) => (index + 1, true),
                None => (available.len(), false),
            }
        };
        reader.consume(consumed);
        if ended {
            return Ok(());
        }
    }
}

pub(super) async fn drain_engine_stderr<R: AsyncBufRead + Unpin>(
    reader: &mut ResumableLineReader<R>,
    diagnostics: &Mutex<TerminalDiagnostics>,
) {
    let mut total = 0usize;
    let mut truncated = false;
    loop {
        match reader.read_line().await {
            Ok(Some(line)) => {
                diagnostics.lock().await.push(&line, false);
                let next_total = total.saturating_add(line.len());
                if truncated || next_total > MAX_ENGINE_STDERR_BYTES {
                    if !truncated {
                        error!("Engine stderr truncated after {MAX_ENGINE_STDERR_BYTES} bytes");
                        truncated = true;
                    }
                    continue;
                }
                total = next_total;
                error!("Engine stderr: {line}");
            }
            Ok(None) => return,
            Err(Error::InvalidInput(reason)) => {
                error!("Engine stderr discarded non-UTF-8 line: {reason}");
            }
            Err(Error::ResourceLimit(reason)) => {
                error!("Engine stderr discarded oversized line: {reason}");
                if let Err(error) = reader.discard_line_remainder().await {
                    error!("Engine stderr drain ended while discarding oversized line: {error}");
                    return;
                }
            }
            Err(error) => {
                error!("Engine stderr drain ended: {error}");
                return;
            }
        }
    }
}

pub(super) struct AbortJoinHandleOnDrop {
    pub(super) handle: Option<tokio::task::JoinHandle<()>>,
}

impl AbortJoinHandleOnDrop {
    pub(super) fn new(handle: tokio::task::JoinHandle<()>) -> Self {
        Self {
            handle: Some(handle),
        }
    }

    pub(super) fn disarm(&mut self) {
        self.handle.take();
    }
}

impl Drop for AbortJoinHandleOnDrop {
    fn drop(&mut self) {
        if let Some(handle) = self.handle.take() {
            handle.abort();
        }
    }
}

#[async_trait]
impl UciIo for ChildUciIo {
    fn observed_exit(&self) -> Option<EngineExitStatus> {
        self.observed_exit.get().copied()
    }
    async fn write_line(&mut self, line: &str) -> Result<(), Error> {
        let mut lease = self.cleanup.lease()?;
        lease
            .control
            .as_mut()
            .ok_or(Error::EngineDisconnected)?
            .write_line(line)
            .await
    }

    async fn read_line(&mut self) -> Result<Option<String>, Error> {
        self.line_reader.read_line().await
    }

    fn is_discarding_line(&self) -> bool {
        self.line_reader.is_discarding_line()
    }

    async fn discard_line_remainder(&mut self) -> Result<(), Error> {
        self.line_reader
            .discard_line_remainder()
            .await
            .map_err(Into::into)
    }

    async fn terminate(
        &mut self,
        quit_timeout: Duration,
        kill_reap_timeout: Duration,
    ) -> Result<(), Error> {
        self.cleanup
            .terminate(quit_timeout, kill_reap_timeout, true)
            .await
    }
}
