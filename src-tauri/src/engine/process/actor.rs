//! The engine actor: `EngineRuntime`, `EngineActor`, the command enum and the actor loop with its protocol-failure recovery.

use super::*;

#[cfg(target_os = "windows")]
pub const CREATE_NO_WINDOW: u32 = 0x08000000;

#[cfg(windows)]
pub(super) fn transfer_windows_resource_seals(
    executable: &EngineExecutable,
    child: &Child,
) -> Result<(), Error> {
    use std::ptr::null_mut;
    use windows_sys::Win32::{
        Foundation::{DuplicateHandle, DUPLICATE_SAME_ACCESS},
        System::Threading::GetCurrentProcess,
    };

    #[cfg(test)]
    let failure = take_spawn_io_failure();
    let target = child.raw_handle().ok_or(Error::EngineDisconnected)?;
    for (index, source) in executable
        .resource_leases()
        .iter()
        .flat_map(|resource| resource.windows_seal_handles())
        .enumerate()
    {
        #[cfg(not(test))]
        let _ = index;
        #[cfg(test)]
        if failure == Some(SpawnIoFailure::ResourceTransferAfter(index)) {
            return Err(std::io::Error::other("injected resource seal transfer failure").into());
        }
        let mut remote = null_mut();
        // Duplicate into this exact child with unchanged access and no inheritance. The
        // returned number belongs to the child, so it must never be closed or owned locally.
        let duplicated = unsafe {
            DuplicateHandle(
                GetCurrentProcess(),
                source,
                target,
                &mut remote,
                0,
                0,
                DUPLICATE_SAME_ACCESS,
            )
        };
        if duplicated == 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        #[cfg(test)]
        SPAWN_RESOURCE_TRANSFER_OBSERVED.with(|slot| {
            if let Some((transferred, sent)) = slot.get() {
                slot.set(Some((transferred + 1, sent)));
            }
        });
    }
    Ok(())
}
/// One-owner UCI actor. Its state/request generation is kept beside IO so a
/// read is never served for a request that is no longer current, and the
/// `search_output_unsynchronized` ready barrier discards what a finished
/// search emits after its `bestmove`. Together they keep an old `bestmove`
/// from being attributed to a replacement search.
pub(super) struct EngineRuntime {
    pub(super) io: Box<dyn UciIo>,
    pub(super) cleanup: Option<Arc<ChildOwner>>,
    pub(super) state: EngineState,
    pub(super) next_request: u64,
    /// Set when a search starts and cleared only by a `readyok` read while
    /// idle. UCI output carries no request id, so a line a finished search
    /// still emits after its `bestmove` is attributable only by this ready
    /// barrier: the engine answers `isready` after it, never before.
    pub(super) search_output_unsynchronized: bool,
    pub(super) deadlines: EngineDeadlines,
    pub(super) logs: BoundedLogs,
    pub(super) resource_redactions: ResourceRedactions,
    /// Drain task for this runtime's child stderr. Taken and joined in
    /// `terminate`; aborted in `Drop` if the runtime is discarded first.
    pub(super) stderr_drain_task: Option<tokio::task::JoinHandle<()>>,
    pub(super) termination_outcome: Option<ActorTerminationOutcome>,
    pub(super) diagnostics: Arc<Mutex<TerminalDiagnostics>>,
    pub(super) terminal_snapshot: Arc<OnceLock<EngineTerminalSnapshot>>,
}

pub(super) type ActorTerminationOutcome = Arc<OnceLock<Result<(), Arc<Error>>>>;
pub(super) type ActorJoin = Shared<BoxFuture<'static, Result<(), Arc<Error>>>>;

/// Cloneable client handle for the single-owner engine task. Search-output reads
/// select against control messages, while command writes and terminal-line or
/// configuration reads select against the termination interrupt via `exchange_io`.
#[derive(Clone)]
pub struct EngineActor {
    pub(super) cleanup: Option<Arc<ChildOwner>>,
    pub(super) tx: mpsc::Sender<EngineCommand>,
    pub(super) control_tx: mpsc::Sender<EngineCommand>,
    // Await protocol-task completion independently of confirmed child reaping.
    // ChildOwner retains cleanup authority, including through PendingActor after
    // this task exits with an unconfirmed reap.
    pub(super) task: Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>,
    pub(super) joined: Arc<StdMutex<Option<ActorJoin>>>,
    pub(super) termination_outcome: ActorTerminationOutcome,
    pub(super) terminal_snapshot: Arc<OnceLock<EngineTerminalSnapshot>>,
    pub(super) interrupt: CancellationToken,
    pub(super) registration_identity: Arc<OnceLock<(EngineKey, u64)>>,
    pub(crate) resources: Arc<[Arc<crate::infra::path_authority::EngineResourceLease>]>,
    pub(super) resource_verify: Duration,
}

#[cfg(test)]
pub(crate) struct TerminationReplyGate {
    pub(crate) parked: AtomicBool,
    pub(super) released: AtomicBool,
    pub(super) release: tokio::sync::Notify,
}

#[cfg(test)]
impl TerminationReplyGate {
    pub(super) fn new() -> Arc<Self> {
        Arc::new(Self {
            parked: AtomicBool::new(false),
            released: AtomicBool::new(false),
            release: tokio::sync::Notify::new(),
        })
    }

    pub(super) async fn park(&self) {
        self.parked.store(true, Ordering::SeqCst);
        while !self.released.load(Ordering::SeqCst) {
            self.release.notified().await;
        }
    }

    pub(crate) fn open(&self) {
        self.released.store(true, Ordering::SeqCst);
        self.release.notify_one();
    }
}

#[cfg(test)]
pub(super) static TERMINATION_REPLY_GATES: crate::infra::test_hooks::KeyedTestValues<
    (EngineKey, u64),
    Arc<TerminationReplyGate>,
> = crate::infra::test_hooks::KeyedTestValues::new();

#[cfg(test)]
pub(super) static TEARDOWN_SNAPSHOT_GATES: crate::infra::test_hooks::KeyedTestValues<
    (EngineKey, u64),
    Arc<TerminationReplyGate>,
> = crate::infra::test_hooks::KeyedTestValues::new();

pub(super) enum EngineCommand {
    Init(oneshot::Sender<Result<(), Error>>),
    ConfigureStart(oneshot::Sender<Result<(), Error>>),
    ConfigureNext(oneshot::Sender<Result<Option<String>, Error>>),
    SetOption {
        name: String,
        value: String,
        resource_values: Vec<String>,
        operation_cancellation: Option<CancellationToken>,
        reply: oneshot::Sender<Result<(), Error>>,
    },
    SetPosition {
        fen: String,
        moves: Vec<String>,
        reply: oneshot::Sender<Result<(), Error>>,
    },
    EnsureReady(oneshot::Sender<Result<(), Error>>),
    StartSearch {
        mode: GoMode,
        reply: oneshot::Sender<Result<EngineRequestId, Error>>,
    },
    NextSearch {
        id: EngineRequestId,
        reply: oneshot::Sender<Result<Option<String>, Error>>,
    },
    Stop(oneshot::Sender<Result<(), Error>>),
    StopRequest {
        id: EngineRequestId,
        reply: oneshot::Sender<Result<(), Error>>,
    },
    Terminate(oneshot::Sender<Result<(), Error>>),
    Logs(oneshot::Sender<Vec<EngineLog>>),
}
impl EngineRuntime {
    pub fn new(io: Box<dyn UciIo>, deadlines: EngineDeadlines) -> Self {
        Self {
            io,
            cleanup: None,
            state: EngineState::Idle,
            next_request: 0,
            search_output_unsynchronized: false,
            deadlines,
            logs: BoundedLogs::default(),
            resource_redactions: ResourceRedactions::default(),
            stderr_drain_task: None,
            termination_outcome: None,
            diagnostics: Arc::default(),
            terminal_snapshot: Arc::default(),
        }
    }

    #[cfg(all(test, unix))]
    pub async fn spawn(
        executable: EngineExecutable,
        deadlines: EngineDeadlines,
    ) -> Result<Self, Error> {
        let cleanup = Arc::new(ChildOwner::default());
        match Self::spawn_owned(executable, deadlines.clone(), cleanup.clone()).await {
            Ok(runtime) => Ok(runtime),
            Err(primary) => Err(Error::with_cleanup(
                primary,
                cleanup
                    .terminate(Duration::ZERO, deadlines.kill_reap, false)
                    .await,
            )),
        }
    }

    pub(super) async fn spawn_owned(
        executable: EngineExecutable,
        deadlines: EngineDeadlines,
        cleanup: Arc<ChildOwner>,
    ) -> Result<Self, Error> {
        let command_target = executable.command_target();
        #[cfg(all(test, unix))]
        let command_target_for_observer = command_target.to_path_buf();
        let mut command = Command::new(command_target);
        #[cfg(windows)]
        command.current_dir(executable.working_directory_path());
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            // Backstop for the one exit path `terminate` does not own: an actor
            // dropped without being terminated. It cannot help on process exit,
            // where nothing is dropped at all — that is what the bounded
            // shutdown in `main` is for.
            .kill_on_drop(true);
        #[cfg(unix)]
        {
            let cwd_fd = executable.working_directory_fd();
            #[cfg(target_os = "linux")]
            let inherited_fds = executable.inherited_fds();
            // Use only async-signal-safe operations in the fork child. The validated cwd
            // stays close-on-exec. Linux exposes only the existing image/resource descriptors,
            // without changing process-global cwd or descriptor flags in the parent.
            unsafe {
                command.pre_exec(move || {
                    if libc::fchdir(cwd_fd) != 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                    #[cfg(target_os = "linux")]
                    for fd in &inherited_fds {
                        let flags = libc::fcntl(*fd, libc::F_GETFD);
                        if flags < 0
                            || libc::fcntl(*fd, libc::F_SETFD, flags & !libc::FD_CLOEXEC) < 0
                        {
                            return Err(std::io::Error::last_os_error());
                        }
                    }
                    Ok(())
                });
            }
        }
        #[cfg(target_os = "windows")]
        command.creation_flags(CREATE_NO_WINDOW);

        let mut child = timeout(deadlines.spawn, async { command.spawn() })
            .await
            .map_err(|_| Error::EngineTimeout("spawning engine".into()))??;
        // Capture failure without returning: every successfully spawned child must enter its
        // cleanup owner before a partial transfer can refuse runtime/protocol construction.
        #[cfg(windows)]
        let resource_transfer = transfer_windows_resource_seals(&executable, &child);
        #[cfg(all(test, unix))]
        observe_spawned_child(&child, &command_target_for_observer);
        #[cfg(all(test, unix))]
        let forced_io_failure = take_spawn_io_failure();
        #[cfg(all(test, unix))]
        let stdin = {
            let stdin = child.stdin.take();
            if forced_io_failure == Some(SpawnIoFailure::NoStdin) {
                None
            } else {
                stdin
            }
        };
        #[cfg(any(not(test), all(test, not(unix))))]
        let stdin = child.stdin.take();
        #[cfg(all(test, unix))]
        let stdout = if forced_io_failure == Some(SpawnIoFailure::NoStdout) {
            None
        } else {
            child.stdout.take()
        };
        #[cfg(any(not(test), all(test, not(unix))))]
        let stdout = child.stdout.take();
        let diagnostics = Arc::new(Mutex::new(TerminalDiagnostics::default()));
        let observed_exit = Arc::new(OnceLock::new());
        let missing_stdin = stdin.is_none();
        let stderr = child.stderr.take();
        {
            let mut state = cleanup.state.lock().unwrap_or_else(|e| e.into_inner());
            state.control = Some(Box::new(ProcessChildControl {
                stdin,
                child,
                observed_exit: observed_exit.clone(),
                kill_started: false,
                #[cfg(all(test, unix))]
                terminate_failure: take_terminate_failure(),
                #[cfg(all(test, unix))]
                force_kill_started: false,
            }));
            state.executable = Some(executable);
        }
        #[cfg(windows)]
        resource_transfer?;
        if missing_stdin {
            return Err(Error::NoStdin);
        }
        let stdout = stdout.ok_or(Error::NoStdout)?;
        let stderr_drain_task = stderr.map(|stderr| {
            let diagnostics = diagnostics.clone();
            tokio::spawn(async move {
                let mut reader = ResumableLineReader::new(BufReader::new(stderr));
                drain_engine_stderr(&mut reader, &diagnostics).await;
            })
        });
        let mut runtime = Self::new(
            Box::new(ChildUciIo {
                cleanup: cleanup.clone(),
                line_reader: ResumableLineReader::new(BufReader::new(stdout)),
                observed_exit,
            }),
            deadlines,
        );
        runtime.stderr_drain_task = stderr_drain_task;
        runtime.cleanup = Some(cleanup);
        runtime.diagnostics = diagnostics;
        Ok(runtime)
    }

    pub(super) async fn init_uci_cancellable(
        &mut self,
        cancellation: &CancellationToken,
    ) -> Result<(), Error> {
        self.send("uci", Some(cancellation)).await?;
        self.wait_for("uciok", self.deadlines.uciok, Some(cancellation))
            .await?;
        self.send("isready", Some(cancellation)).await?;
        self.wait_for("readyok", self.deadlines.readyok, Some(cancellation))
            .await
    }

    pub async fn ensure_ready(
        &mut self,
        interrupt: Option<&CancellationToken>,
    ) -> Result<(), Error> {
        // Only an idle engine's `readyok` closes a search's output: during a
        // search, lines of that search still follow it.
        let idle = self.state == EngineState::Idle;
        self.send("isready", interrupt).await?;
        self.wait_for("readyok", self.deadlines.readyok, interrupt)
            .await?;
        if idle {
            self.search_output_unsynchronized = false;
        }
        Ok(())
    }

    pub async fn start_uci_configuration(
        &mut self,
        interrupt: Option<&CancellationToken>,
    ) -> Result<(), Error> {
        self.send("uci", interrupt).await
    }

    pub(super) async fn next_configuration_line_cancellable(
        &mut self,
        cancellation: &CancellationToken,
    ) -> Result<Option<String>, Error> {
        let deadline = Instant::now() + self.deadlines.uciok;
        let line = exchange_io(
            self.read_line(),
            deadline,
            "waiting for uciok",
            Some(cancellation),
        )
        .await?;
        line.map(Some).ok_or_else(disconnected_failure)
    }

    pub(super) async fn set_option_with_resources(
        &mut self,
        name: &str,
        value: &str,
        resource_values: &[String],
        operation_cancellation: Option<&CancellationToken>,
        interrupt: Option<&CancellationToken>,
    ) -> Result<(), Error> {
        validate_uci_text("option name", name)?;
        validate_uci_text("option value", value)?;
        self.resource_redactions
            .register(resource_values, &mut self.logs)?;
        self.diagnostics
            .lock()
            .await
            .register(&self.resource_redactions.values);
        #[cfg(all(test, unix))]
        if !resource_values.is_empty() {
            let hook = SET_OPTION_BEFORE_SEND_HOOK.with(|slot| slot.borrow_mut().take());
            if let Some(hook) = hook {
                hook();
            }
        }
        if operation_cancellation.is_some_and(CancellationToken::is_cancelled) {
            return Err(Error::Cancellation);
        }
        self.send(&format!("setoption name {name} value {value}"), interrupt)
            .await
    }

    pub async fn set_position(
        &mut self,
        fen: &str,
        moves: &[String],
        interrupt: Option<&CancellationToken>,
    ) -> Result<(), Error> {
        let position = canonicalize_engine_position(fen, moves)?;
        self.send(&position.command(), interrupt).await
    }

    pub async fn start_search(
        &mut self,
        mode: &GoMode,
        interrupt: Option<&CancellationToken>,
    ) -> Result<EngineRequestId, Error> {
        if matches!(
            self.state,
            EngineState::Searching { .. } | EngineState::Stopping { .. }
        ) {
            self.stop_current(interrupt).await?;
        }
        // Discard whatever the previous search emitted after its `bestmove`
        // (a delayed `info`, a duplicate `bestmove`) before `go`, so the new
        // request id cannot adopt it. `wait_for` drops every line before
        // `readyok`.
        if self.search_output_unsynchronized {
            self.ensure_ready(interrupt).await?;
        }
        self.next_request = self
            .next_request
            .checked_add(1)
            .ok_or_else(|| Error::ResourceLimit("engine request generation exhausted".into()))?;
        let id = EngineRequestId(self.next_request);
        self.send(&mode.to_uci_string()?, interrupt).await?;
        self.search_output_unsynchronized = true;
        self.state = EngineState::Searching { request_id: id };
        Ok(id)
    }

    pub async fn stop_current(
        &mut self,
        interrupt: Option<&CancellationToken>,
    ) -> Result<(), Error> {
        let deadline = Instant::now() + self.deadlines.stop;
        let send_stop = match self.state {
            EngineState::Searching { request_id } => {
                self.state = EngineState::Stopping { request_id };
                true
            }
            // A prior cancellation may have written `stop` while the actor
            // was servicing a pending read. Do not permit a new `position` or
            // `go` until that exact search's required `bestmove` is drained.
            EngineState::Stopping { .. } => false,
            EngineState::Idle | EngineState::Terminating => return Ok(()),
        };
        let result = async {
            if send_stop {
                self.send_with_deadline("stop", deadline, interrupt).await?;
            }
            self.read_until(
                deadline,
                "waiting for bestmove after stop",
                interrupt,
                |line| matches!(vampirc_uci::parse_one(line), UciMessage::BestMove { .. }),
            )
            .await
        }
        .await;
        // A failed stop has no trustworthy protocol boundary. Mark the
        // runtime poisoned; every command handler that observes this error
        // terminates the actor rather than allowing a later request to reuse
        // an unread old `bestmove`.
        self.state = if result.is_ok() {
            EngineState::Idle
        } else {
            EngineState::Terminating
        };
        result
    }

    pub async fn terminate(&mut self) -> Result<(), Error> {
        self.state = EngineState::Terminating;
        let result = self
            .io
            .terminate(self.deadlines.quit, self.deadlines.kill_reap)
            .await;
        self.reap_stderr_drain().await;
        self.state = EngineState::Idle;
        match &self.termination_outcome {
            Some(outcome) => {
                let result = result.map_err(Arc::new);
                let _ = outcome.set(result.clone());
                result.map_err(Error::Shared)
            }
            None => result,
        }
    }

    pub(super) async fn reap_stderr_drain(&mut self) {
        let Some(handle) = self.stderr_drain_task.take() else {
            return;
        };
        let mut guard = AbortJoinHandleOnDrop::new(handle);
        let Some(handle) = guard.handle.as_mut() else {
            return;
        };
        match timeout(STDERR_REAP_TIMEOUT, handle).await {
            Ok(Ok(())) => guard.disarm(),
            Ok(Err(error)) => {
                error!("Engine stderr drain task failed while joining: {error}");
                guard.disarm();
            }
            Err(_) => {
                let Some(handle) = guard.handle.as_mut() else {
                    return;
                };
                handle.abort();
                match handle.await {
                    Ok(()) => error!("Engine stderr drain exceeded join budget and was aborted"),
                    Err(error) if error.is_cancelled() => {
                        error!("Engine stderr drain exceeded join budget and was aborted: {error}");
                    }
                    Err(error) => {
                        error!("Engine stderr drain failed after abort: {error}");
                    }
                }
                guard.disarm();
            }
        }
    }

    pub(super) async fn send(
        &mut self,
        command: &str,
        interrupt: Option<&CancellationToken>,
    ) -> Result<(), Error> {
        self.send_with_deadline(command, Instant::now() + self.deadlines.readyok, interrupt)
            .await
    }

    pub(super) async fn send_with_deadline(
        &mut self,
        command: &str,
        deadline: Instant,
        interrupt: Option<&CancellationToken>,
    ) -> Result<(), Error> {
        #[cfg(all(test, windows))]
        SPAWN_RESOURCE_TRANSFER_OBSERVED.with(|slot| {
            if let Some((transferred, sent)) = slot.get() {
                slot.set(Some((transferred, sent + 1)));
            }
        });
        validate_uci_text("UCI command", command)?;
        self.logs.push(EngineLog::Gui(
            self.resource_redactions.redact(format!("{command}\n")),
        ));
        let result = exchange_io(
            self.io.write_line(command),
            deadline,
            "writing engine command",
            interrupt,
        )
        .await;
        result.map_err(|error| match error {
            Error::EngineDisconnected | Error::EngineTimeout(_) => error,
            error => protocol_failure(error),
        })
    }

    pub(super) async fn read_line(&mut self) -> Result<Option<String>, Error> {
        let line = self.io.read_line().await.map_err(protocol_failure)?;
        if let Some(line) = &line {
            if line.len() > MAX_ENGINE_LINE_BYTES {
                return Err(protocol_failure(Error::ResourceLimit(format!(
                    "engine emitted a line larger than {MAX_ENGINE_LINE_BYTES} bytes"
                ))));
            }
            self.record_output_line(line).await;
        }
        Ok(line)
    }

    pub(super) async fn record_output_line(&mut self, line: &str) {
        if let Some(text) = line
            .trim_start()
            .strip_prefix("info")
            .filter(|text| text.starts_with(char::is_whitespace))
            .and_then(|text| text.trim_start().strip_prefix("string"))
        {
            if text.is_empty() || text.starts_with(char::is_whitespace) {
                self.diagnostics.lock().await.push(text.trim(), true);
            }
        }
        self.logs.push(EngineLog::Engine(
            self.resource_redactions.redact(line.to_owned()),
        ));
    }

    pub(super) async fn drain_terminal_stdout(
        &mut self,
        registration_identity: &OnceLock<(EngineKey, u64)>,
    ) {
        let mut discarded = 0usize;
        // Reuse the pipe-join budget. A descendant may still hold stdout open.
        let _ = timeout(STDERR_REAP_TIMEOUT, async {
            if self.io.is_discarding_line() && self.io.discard_line_remainder().await.is_err() {
                return;
            }
            loop {
                match self.io.read_line().await {
                    Ok(Some(line)) if line.len() <= MAX_ENGINE_LINE_BYTES => {
                        self.record_output_line(&line).await;
                    }
                    Ok(Some(_)) => {}
                    Err(Error::InvalidInput(_)) => discarded += 1,
                    Err(Error::ResourceLimit(_)) => {
                        if self.io.discard_line_remainder().await.is_err() {
                            break;
                        }
                    }
                    _ => break,
                }
            }
        })
        .await;
        if discarded > 0 {
            match registration_identity.get() {
                Some((key, generation)) => error!(
                    "Engine stdout discarded non-UTF-8 lines: tab={} engine={} generation={} count={}",
                    key.tab, key.engine, generation, discarded
                ),
                None => error!("Engine stdout discarded non-UTF-8 lines: unregistered count={discarded}"),
            }
        }
    }

    pub(super) async fn wait_for(
        &mut self,
        expected: &str,
        wait: Duration,
        interrupt: Option<&CancellationToken>,
    ) -> Result<(), Error> {
        let deadline = Instant::now() + wait;
        let timeout_label = format!("waiting for {expected}");
        self.read_until(deadline, &timeout_label, interrupt, |line| {
            // UCI acknowledgements are complete protocol tokens. Prefix
            // matching would accept e.g. `uciok-not-really` from a malformed
            // or hostile executable and advance the state machine.
            line.trim() == expected
        })
        .await
    }

    pub(super) async fn read_until<F>(
        &mut self,
        deadline: Instant,
        timeout_label: &str,
        cancellation: Option<&CancellationToken>,
        mut is_terminal: F,
    ) -> Result<(), Error>
    where
        F: FnMut(&str) -> bool,
    {
        loop {
            let Some(line) =
                exchange_io(self.read_line(), deadline, timeout_label, cancellation).await?
            else {
                return Err(disconnected_failure());
            };
            if is_terminal(&line) {
                return Ok(());
            }
        }
    }
}

/// One cancellation-before-use boundary for command writes and protocol reads.
/// Teardown deliberately does not pass through this helper.
pub(super) async fn exchange_io<T>(
    operation: impl std::future::Future<Output = Result<T, Error>>,
    deadline: Instant,
    timeout_label: &str,
    interrupt: Option<&CancellationToken>,
) -> Result<T, Error> {
    tokio::select! {
        biased;
        _ = async {
            match interrupt {
                Some(interrupt) => interrupt.cancelled().await,
                None => std::future::pending().await,
            }
        } => Err(Error::EngineDisconnected),
        result = timeout_at(deadline, operation) => {
            result.map_err(|_| Error::EngineTimeout(timeout_label.into()))?
        }
    }
}

impl Drop for EngineRuntime {
    fn drop(&mut self) {
        if let Some(handle) = self.stderr_drain_task.take() {
            handle.abort();
        }
    }
}
impl EngineActor {
    #[cfg(test)]
    pub(crate) fn recoverable_cleanup_test_actor() -> Arc<Self> {
        Self::recoverable_cleanup_test_actor_with_cause("production-loop-reap-failure")
    }

    #[cfg(test)]
    pub(crate) fn recoverable_cleanup_test_actor_with_cause(cause: &str) -> Arc<Self> {
        let mut actor = Self::new(
            Box::new(GameCleanupTestIo {
                started: Arc::default(),
                delay: None,
                error: Some(cause.into()),
            }),
            EngineDeadlines::default(),
        );
        let (child, _, _) = tests::child_control([tests::FakeWait::Ready]);
        let cleanup = Arc::new(ChildOwner::default());
        cleanup.state.lock().unwrap().control = Some(Box::new(child));
        actor.cleanup = Some(cleanup);
        Arc::new(actor)
    }

    #[cfg(all(test, unix))]
    pub(super) fn clear_cleanup_test_failure(&self) {
        if let Some(cleanup) = &self.cleanup {
            if let Some(control) = cleanup.state.lock().unwrap().control.as_mut() {
                control.clear_failure();
            }
        }
    }
    #[cfg(all(test, unix))]
    pub(crate) fn set_test_option_before_send_hook(hook: Option<Box<dyn FnOnce() + Send>>) {
        set_option_before_send_hook(hook);
    }

    #[cfg(test)]
    pub fn new(io: Box<dyn UciIo>, deadlines: EngineDeadlines) -> Self {
        Self::from_runtime(EngineRuntime::new(io, deadlines))
    }

    #[cfg(test)]
    pub fn recording_test_actor(lines: &[&str]) -> (Arc<Self>, Arc<Mutex<Vec<String>>>) {
        Self::recording_test_actor_with_resources_and_deadlines_impl(
            lines,
            Vec::new(),
            EngineDeadlines::default(),
            None,
        )
    }

    #[cfg(test)]
    pub(crate) fn gated_pending_test_actor(
        failure: Option<&'static str>,
    ) -> (
        Arc<Self>,
        Arc<TerminationReplyGate>,
        Arc<std::sync::atomic::AtomicUsize>,
    ) {
        tests::gated_pending_actor(failure)
    }

    #[cfg(test)]
    pub(crate) fn failing_terminate_test_actor(error: impl Into<String>) -> Arc<Self> {
        Arc::new(Self::new(
            Box::new(GameCleanupTestIo {
                started: Arc::new(AtomicBool::new(false)),
                delay: None,
                error: Some(error.into()),
            }),
            EngineDeadlines::default(),
        ))
    }

    #[cfg(test)]
    pub(crate) fn recording_failure_test_actor(
        lines: &[&str],
        fail_stop: bool,
        termination_error: Option<&str>,
    ) -> Arc<Self> {
        let mut io = FakeIo::new(
            Arc::default(),
            lines.iter().map(|line| Some((*line).into())),
        );
        io.fail_stop = fail_stop;
        io.pending_when_empty = fail_stop;
        io.termination_error =
            termination_error.map(|error| Arc::new(std::io::Error::other(error.to_owned()).into()));
        Arc::new(Self::new(Box::new(io), EngineDeadlines::default()))
    }

    #[cfg(test)]
    pub(crate) fn delayed_terminate_test_actor(delay: Duration) -> (Arc<Self>, Arc<AtomicBool>) {
        let started = Arc::new(AtomicBool::new(false));
        (
            Arc::new(Self::new(
                Box::new(GameCleanupTestIo {
                    started: started.clone(),
                    delay: Some(delay),
                    error: None,
                }),
                EngineDeadlines::default(),
            )),
            started,
        )
    }

    #[cfg(all(test, unix))]
    pub fn recording_test_actor_with_resources(
        lines: &[&str],
        resources: Vec<Arc<crate::infra::path_authority::EngineResourceLease>>,
    ) -> (Arc<Self>, Arc<Mutex<Vec<String>>>) {
        Self::recording_test_actor_with_resources_and_deadlines(
            lines,
            resources,
            EngineDeadlines::default(),
        )
    }

    #[cfg(all(test, unix))]
    pub fn recording_test_actor_with_resources_and_deadlines(
        lines: &[&str],
        resources: Vec<Arc<crate::infra::path_authority::EngineResourceLease>>,
        deadlines: EngineDeadlines,
    ) -> (Arc<Self>, Arc<Mutex<Vec<String>>>) {
        Self::recording_test_actor_with_resources_and_deadlines_impl(
            lines, resources, deadlines, None,
        )
    }

    #[cfg(test)]
    pub(crate) fn recording_test_actor_cancelling_after_write(
        lines: &[&str],
        resources: Vec<Arc<crate::infra::path_authority::EngineResourceLease>>,
        command: String,
        cancelled: Arc<AtomicBool>,
    ) -> (Arc<Self>, Arc<Mutex<Vec<String>>>) {
        Self::recording_test_actor_with_resources_and_deadlines_impl(
            lines,
            resources,
            EngineDeadlines::default(),
            Some((command, cancelled)),
        )
    }

    #[cfg(test)]
    pub(super) fn recording_test_actor_with_resources_and_deadlines_impl(
        lines: &[&str],
        resources: Vec<Arc<crate::infra::path_authority::EngineResourceLease>>,
        deadlines: EngineDeadlines,
        cancel_after_write: Option<(String, Arc<AtomicBool>)>,
    ) -> (Arc<Self>, Arc<Mutex<Vec<String>>>) {
        let writes = Arc::new(Mutex::new(Vec::new()));
        let mut io = FakeIo::new(
            writes.clone(),
            lines.iter().map(|line| Some((*line).into())),
        );
        io.cancel_after_write = cancel_after_write;
        (
            Arc::new(Self::from_runtime_with_resources(
                EngineRuntime::new(Box::new(io), deadlines),
                Arc::from(resources),
            )),
            writes,
        )
    }

    #[cfg(test)]
    pub(super) fn from_runtime(runtime: EngineRuntime) -> Self {
        Self::from_runtime_with_resources(runtime, Arc::from([]))
    }

    pub(super) fn from_runtime_with_resources(
        mut runtime: EngineRuntime,
        resources: Arc<[Arc<crate::infra::path_authority::EngineResourceLease>]>,
    ) -> Self {
        let resource_verify = runtime.deadlines.resource_verify;
        let cleanup = runtime.cleanup.clone();
        let (tx, rx) = mpsc::channel(32);
        // Lifecycle and observability controls never sit behind bulk analysis
        // work. A flooded normal queue therefore cannot delay stop, kill or
        // log snapshots for a silent engine.
        let (control_tx, control_rx) = mpsc::channel(8);
        let interrupt = CancellationToken::new();
        let registration_identity = Arc::new(OnceLock::new());
        let termination_outcome = Arc::new(OnceLock::new());
        let terminal_snapshot = runtime.terminal_snapshot.clone();
        runtime.termination_outcome = Some(termination_outcome.clone());
        let task = tokio::spawn(engine_actor_loop(
            runtime,
            rx,
            control_rx,
            interrupt.clone(),
            registration_identity.clone(),
        ));
        Self {
            cleanup,
            tx,
            control_tx,
            task: Arc::new(Mutex::new(Some(task))),
            joined: Arc::default(),
            termination_outcome,
            terminal_snapshot,
            interrupt,
            registration_identity,
            resources,
            resource_verify,
        }
    }

    #[cfg(all(test, unix))]
    pub async fn spawn(
        executable: EngineExecutable,
        deadlines: EngineDeadlines,
    ) -> Result<Self, Error> {
        #[cfg(test)]
        if let Some(actor) = SPAWN_ACTOR_OVERRIDE.with(|slot| slot.borrow_mut().take()) {
            return Ok(actor);
        }
        let resources = Arc::from(executable.resource_leases().to_vec());
        Ok(Self::from_runtime_with_resources(
            EngineRuntime::spawn(executable, deadlines).await?,
            resources,
        ))
    }

    pub(super) async fn spawn_owned(
        executable: EngineExecutable,
        deadlines: EngineDeadlines,
        cleanup: Arc<ChildOwner>,
    ) -> Result<Self, Error> {
        #[cfg(test)]
        if let Some(mut actor) = SPAWN_ACTOR_OVERRIDE.with(|slot| slot.borrow_mut().take()) {
            actor.cleanup = Some(cleanup);
            return Ok(actor);
        }
        let resources = Arc::from(executable.resource_leases().to_vec());
        Ok(Self::from_runtime_with_resources(
            EngineRuntime::spawn_owned(executable, deadlines, cleanup).await?,
            resources,
        ))
    }

    #[cfg(all(test, unix))]
    pub async fn spawn_initialized(
        executable: EngineExecutable,
        deadlines: EngineDeadlines,
    ) -> Result<Self, Error> {
        let actor = Self::spawn(executable, deadlines).await?;
        if let Err(error) = actor.init_uci().await {
            return Err(Error::with_cleanup(error, actor.terminate().await));
        }
        Ok(actor)
    }

    pub(super) async fn request<T>(
        &self,
        command: EngineCommand,
        reply: oneshot::Receiver<T>,
    ) -> Result<T, Error> {
        self.tx
            .send(command)
            .await
            .map_err(|_| self.disconnected_error())?;
        reply.await.map_err(|_| self.disconnected_error())
    }

    pub(super) async fn request_control<T>(
        &self,
        command: EngineCommand,
        reply: oneshot::Receiver<T>,
    ) -> Result<T, Error> {
        self.control_tx
            .send(command)
            .await
            .map_err(|_| Error::EngineDisconnected)?;
        reply.await.map_err(|_| Error::EngineDisconnected)
    }

    /// Enqueue a `setoption` on the normal command channel without awaiting the
    /// actor. Used to fill that channel while a search read is parked in
    /// `select!`; an `await`ed `set_option` would yield and let the actor drain
    /// the first item, dropping the delayed read.
    #[cfg(test)]
    pub(super) fn try_enqueue_set_option(
        &self,
        name: String,
        value: String,
    ) -> Result<oneshot::Receiver<Result<(), Error>>, mpsc::error::TrySendError<EngineCommand>>
    {
        let (reply_tx, reply) = oneshot::channel();
        self.tx
            .try_send(EngineCommand::SetOption {
                name,
                value,
                resource_values: Vec::new(),
                operation_cancellation: None,
                reply: reply_tx,
            })
            .map(|()| reply)
    }

    pub async fn init_uci(&self) -> Result<(), Error> {
        let (reply_tx, reply) = oneshot::channel();
        self.request(EngineCommand::Init(reply_tx), reply).await?
    }
    pub async fn start_uci_configuration(&self) -> Result<(), Error> {
        let (reply_tx, reply) = oneshot::channel();
        self.request(EngineCommand::ConfigureStart(reply_tx), reply)
            .await?
    }
    pub async fn next_configuration_line(&self) -> Result<Option<String>, Error> {
        let (reply_tx, reply) = oneshot::channel();
        self.request(EngineCommand::ConfigureNext(reply_tx), reply)
            .await?
    }
    pub async fn set_option(&self, name: &str, value: &str) -> Result<(), Error> {
        self.set_option_with_operation(name, value, &[], None).await
    }
    pub(crate) async fn set_option_with_resources(
        &self,
        name: &str,
        value: &str,
        resource_values: &[String],
    ) -> Result<(), Error> {
        self.set_option_with_operation(name, value, resource_values, None)
            .await
    }
    pub(crate) async fn set_option_with_operation(
        &self,
        name: &str,
        value: &str,
        resource_values: &[String],
        operation_cancellation: Option<CancellationToken>,
    ) -> Result<(), Error> {
        let (reply_tx, reply) = oneshot::channel();
        self.request(
            EngineCommand::SetOption {
                name: name.into(),
                value: value.into(),
                resource_values: resource_values.to_vec(),
                operation_cancellation,
                reply: reply_tx,
            },
            reply,
        )
        .await?
    }
    pub async fn set_position(&self, fen: &str, moves: &[String]) -> Result<(), Error> {
        let (reply_tx, reply) = oneshot::channel();
        self.request(
            EngineCommand::SetPosition {
                fen: fen.into(),
                moves: moves.to_vec(),
                reply: reply_tx,
            },
            reply,
        )
        .await?
    }
    pub async fn ensure_ready(&self) -> Result<(), Error> {
        let (reply_tx, reply) = oneshot::channel();
        self.request(EngineCommand::EnsureReady(reply_tx), reply)
            .await?
    }
    pub async fn start_search(&self, mode: &GoMode) -> Result<EngineRequestId, Error> {
        let (reply_tx, reply) = oneshot::channel();
        self.request(
            EngineCommand::StartSearch {
                mode: mode.clone(),
                reply: reply_tx,
            },
            reply,
        )
        .await?
    }
    pub async fn wait_bestmove_cancellable(
        &self,
        request: EngineRequestId,
        cancellation: &CancellationToken,
    ) -> Result<String, Error> {
        loop {
            tokio::select! {
                _ = cancellation.cancelled() => {
                    self.stop_request(request).await?;
                    return Err(Error::AnalysisCancelled);
                }
                line = self.next_search_line(request) => {
                    let Some(line) = line? else {
                        return Err(Error::EngineDisconnected);
                    };
                    if let UciMessage::BestMove { best_move, .. } = vampirc_uci::parse_one(&line) {
                        return Ok(best_move.to_string());
                    }
                }
            }
        }
    }
    pub async fn next_search_line(&self, id: EngineRequestId) -> Result<Option<String>, Error> {
        let (reply_tx, reply) = oneshot::channel();
        self.request(
            EngineCommand::NextSearch {
                id,
                reply: reply_tx,
            },
            reply,
        )
        .await?
    }
    pub async fn next_search_line_cancellable(
        &self,
        id: EngineRequestId,
        cancelled: &std::sync::atomic::AtomicBool,
    ) -> Result<Option<String>, Error> {
        if cancelled.load(Ordering::SeqCst) {
            self.stop_request(id).await?;
            return Err(Error::AnalysisCancelled);
        }
        let next_line = self.next_search_line(id);
        tokio::pin!(next_line);
        let mut cancellation_poll = tokio::time::interval_at(
            tokio::time::Instant::now() + Duration::from_millis(25),
            Duration::from_millis(25),
        );
        cancellation_poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tokio::select! {
                result = &mut next_line => return result,
                _ = cancellation_poll.tick() => {
                    if cancelled.load(Ordering::SeqCst) {
                        self.stop_request(id).await?;
                        return Err(Error::AnalysisCancelled);
                    }
                }
            }
        }
    }
    pub async fn stop_current(&self) -> Result<(), Error> {
        // Recovery already stopped/reaped a terminal actor. Report that reap,
        // rather than treating its closed command channel as another failure.
        if self.terminal_snapshot().is_some() {
            return self.final_termination_outcome().await;
        }
        let (reply_tx, reply) = oneshot::channel();
        self.request_control(EngineCommand::Stop(reply_tx), reply)
            .await?
    }
    pub async fn stop_request(&self, id: EngineRequestId) -> Result<(), Error> {
        let (reply_tx, reply) = oneshot::channel();
        self.request_control(
            EngineCommand::StopRequest {
                id,
                reply: reply_tx,
            },
            reply,
        )
        .await?
    }
    pub async fn terminate(&self) -> Result<(), Error> {
        self.interrupt.cancel();
        let (reply_tx, reply) = oneshot::channel();
        let termination = self
            .request_control(EngineCommand::Terminate(reply_tx), reply)
            .await
            .and_then(|result| result);
        #[cfg(test)]
        if let Some((key, generation)) = self.registration_identity.get() {
            let identity = (key.clone(), *generation);
            if let Some(gate) = TERMINATION_REPLY_GATES.take(&identity) {
                gate.park().await;
            }
        }
        let reaped = self.reap_task().await;
        let termination = if matches!(&termination, Err(Error::EngineDisconnected)) {
            self.recorded_termination_outcome()
        } else {
            termination
        };
        combine_shutdown_results(termination, reaped)
    }

    pub(super) fn recorded_termination_outcome(&self) -> Result<(), Error> {
        self.termination_outcome
            .get()
            .cloned()
            .ok_or(Error::EngineDisconnected)?
            .map_err(Error::Shared)
    }

    pub(super) async fn final_termination_outcome(&self) -> Result<(), Error> {
        let joined = self.reap_task().await;
        combine_shutdown_results(self.recorded_termination_outcome(), joined)
    }

    pub(super) async fn reap_task(&self) -> Result<(), Error> {
        // Share the join as well as the reap outcome. A concurrent caller must
        // await completion even if another caller already took the handle.
        let joined = {
            let mut task = self.task.lock().await;
            let mut joined = self
                .joined
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if joined.is_none() {
                if let Some(task) = task.take() {
                    let owner = self
                        .registration_identity
                        .get()
                        .map(|(key, generation)| {
                            format!("{}:{} generation={generation}", key.tab, key.engine)
                        })
                        .unwrap_or_else(|| "unregistered actor".into());
                    *joined = Some(
                        async move {
                            task.await.map_err(|error| {
                                Arc::new(Error::task_join(
                                    "engine actor task failed",
                                    &error,
                                    &owner,
                                ))
                            })
                        }
                        .boxed()
                        .shared(),
                    );
                }
            }
            joined.clone()
        };
        match joined {
            Some(joined) => joined.await.map_err(Error::Shared),
            None => Err(Error::EngineDisconnected),
        }
    }
    pub async fn logs(&self) -> Result<Vec<EngineLog>, Error> {
        let (reply_tx, reply) = oneshot::channel();
        self.request_control(EngineCommand::Logs(reply_tx), reply)
            .await
    }

    /// Kept independently of the consumed runtime and exact-generation reap.
    pub fn terminal_snapshot(&self) -> Option<&EngineTerminalSnapshot> {
        self.terminal_snapshot.get()
    }

    pub(super) fn disconnected_error(&self) -> Error {
        match self.terminal_snapshot() {
            Some(snapshot) => Error::EngineFailure {
                snapshot: Some(Box::new(snapshot.clone())),
                cause: Box::new(Error::EngineDisconnected),
                cleanup: None,
            },
            None => Error::EngineDisconnected,
        }
    }
}

pub(crate) async fn verify_option_resources(
    actor: &EngineActor,
    options: &[ResolvedEngineOption],
    operation_cancellation: Option<&CancellationToken>,
) -> Result<(), Error> {
    verify_option_resources_in(&BLOCKING_GATEWAY, actor, options, operation_cancellation).await
}

pub(crate) async fn verify_option_resources_in(
    gateway: &BlockingGateway,
    actor: &EngineActor,
    options: &[ResolvedEngineOption],
    operation_cancellation: Option<&CancellationToken>,
) -> Result<(), Error> {
    let resources = actor.resources.clone();
    let values = options
        .iter()
        .flat_map(|option| option.resource_values.iter().cloned())
        .collect::<Vec<_>>();
    #[cfg(all(test, unix))]
    let verify_hook_key = values.first().cloned();
    let verify = gateway.spawn(move || {
        #[cfg(all(test, unix))]
        if let Some(key) = verify_hook_key {
            RESOURCE_VERIFY_HOOKS.run(&key);
        }
        for value in values {
            let Some(resource) = resources.iter().find(|resource| {
                resource
                    .uci_value()
                    .is_ok_and(|candidate| candidate == value)
            }) else {
                return Err(Error::Conflict(
                    "engine option resource was not produced by the launched engine".into(),
                ));
            };
            resource.verify_current()?;
        }
        Ok(())
    });
    let operation_cancellation = operation_cancellation.cloned();
    tokio::pin!(verify);
    tokio::select! {
        biased;
        _ = actor.interrupt.cancelled() => Err(Error::Cancellation),
        _ = async {
            if let Some(operation_cancellation) = &operation_cancellation {
                operation_cancellation.cancelled().await;
            } else {
                std::future::pending::<()>().await;
            }
        } => Err(Error::Cancellation),
        result = tokio::time::timeout(actor.resource_verify, &mut verify) => {
            result.map_err(|_| Error::EngineTimeout("verifying engine option resources".into()))?
        }
    }
}

#[cfg(test)]
std::thread_local! {
    pub(super) static SPAWN_ACTOR_OVERRIDE: std::cell::RefCell<Option<EngineActor>> =
        const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
pub(super) struct SpawnActorOverrideGuard {
    // The override must be consumed and cleared on the thread where it was set.
    pub(super) _same_thread: std::marker::PhantomData<std::rc::Rc<()>>,
}

#[cfg(test)]
impl SpawnActorOverrideGuard {
    pub(super) fn new(actor: EngineActor) -> Self {
        SPAWN_ACTOR_OVERRIDE.with(|slot| {
            let mut slot = slot.borrow_mut();
            assert!(slot.is_none(), "a spawn override is already armed");
            *slot = Some(actor);
        });
        Self {
            _same_thread: std::marker::PhantomData,
        }
    }
}

#[cfg(test)]
impl Drop for SpawnActorOverrideGuard {
    fn drop(&mut self) {
        SPAWN_ACTOR_OVERRIDE.with(|slot| *slot.borrow_mut() = None);
    }
}

#[cfg(all(test, unix))]
pub(super) type ResourceVerifyHook = crate::infra::test_hooks::TestHook;

/// Keyed by the resource value under verification; see `infra::test_hooks`.
#[cfg(all(test, unix))]
pub(super) static RESOURCE_VERIFY_HOOKS: crate::infra::test_hooks::KeyedTestHooks<String> =
    crate::infra::test_hooks::KeyedTestHooks::new();

#[cfg(all(test, unix))]
pub(super) fn set_resource_verify_hook(key: String, hook: Option<ResourceVerifyHook>) {
    match hook {
        Some(hook) => RESOURCE_VERIFY_HOOKS.arm(key, hook),
        None => RESOURCE_VERIFY_HOOKS.clear(&key),
    }
}

#[cfg(all(test, unix))]
std::thread_local! {
    pub(super) static SET_OPTION_BEFORE_SEND_HOOK: std::cell::RefCell<Option<ResourceVerifyHook>> =
        const { std::cell::RefCell::new(None) };
}

#[cfg(all(test, unix))]
pub(super) fn set_option_before_send_hook(hook: Option<Box<dyn FnOnce() + Send>>) {
    SET_OPTION_BEFORE_SEND_HOOK.with(|slot| *slot.borrow_mut() = hook);
}

#[cfg(test)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum SpawnIoFailure {
    #[cfg(unix)]
    NoStdin,
    #[cfg(unix)]
    NoStdout,
    #[cfg(windows)]
    ResourceTransferAfter(usize),
}

#[cfg(test)]
std::thread_local! {
    pub(super) static SPAWN_IO_FAILURE: std::cell::RefCell<Option<SpawnIoFailure>> =
        const { std::cell::RefCell::new(None) };
}

#[cfg(all(test, windows))]
std::thread_local! {
    pub(super) static SPAWN_RESOURCE_TRANSFER_OBSERVED: std::cell::Cell<Option<(usize, usize)>> =
        const { std::cell::Cell::new(None) };
}

#[cfg(all(test, unix))]
pub(super) type SpawnChildObserver = Box<dyn FnOnce(Option<u32>) + Send>;

#[cfg(all(test, unix))]
pub(super) type SpawnChildObserverRegistration = (Arc<()>, SpawnChildObserver);

#[cfg(all(test, unix))]
pub(super) struct SpawnChildObserverGuard {
    pub(super) command_target: std::path::PathBuf,
    pub(super) registration_id: Arc<()>,
}

#[cfg(all(test, unix))]
pub(super) static SPAWN_CHILD_OBSERVERS: std::sync::OnceLock<
    std::sync::Mutex<HashMap<std::path::PathBuf, SpawnChildObserverRegistration>>,
> = std::sync::OnceLock::new();

#[cfg(test)]
pub(super) fn set_spawn_io_failure(failure: Option<SpawnIoFailure>) {
    SPAWN_IO_FAILURE.with(|slot| *slot.borrow_mut() = failure);
}

#[cfg(test)]
pub(super) fn take_spawn_io_failure() -> Option<SpawnIoFailure> {
    SPAWN_IO_FAILURE.with(|slot| slot.borrow_mut().take())
}

#[cfg(all(test, unix))]
pub(super) fn set_spawn_child_observer(
    command_target: std::path::PathBuf,
    observer: SpawnChildObserver,
) -> SpawnChildObserverGuard {
    let mut observers = SPAWN_CHILD_OBSERVERS
        .get_or_init(|| std::sync::Mutex::new(HashMap::new()))
        .lock()
        .unwrap();
    let registration_id = Arc::new(());
    observers.insert(command_target.clone(), (registration_id.clone(), observer));
    SpawnChildObserverGuard {
        command_target,
        registration_id,
    }
}

#[cfg(all(test, unix))]
impl Drop for SpawnChildObserverGuard {
    fn drop(&mut self) {
        let mut observers = SPAWN_CHILD_OBSERVERS
            .get_or_init(|| std::sync::Mutex::new(HashMap::new()))
            .lock()
            .unwrap();
        // An executable fd can be reused while its consumed observer's guard is still alive.
        if observers
            .get(&self.command_target)
            .is_some_and(|(id, _)| Arc::ptr_eq(id, &self.registration_id))
        {
            observers.remove(&self.command_target);
        }
    }
}

#[cfg(all(test, unix))]
pub(super) fn take_spawn_child_observer(
    command_target: &std::path::Path,
) -> Option<SpawnChildObserver> {
    SPAWN_CHILD_OBSERVERS
        .get_or_init(|| std::sync::Mutex::new(HashMap::new()))
        .lock()
        .unwrap()
        .remove(command_target)
        .map(|(_, observer)| observer)
}

#[cfg(all(test, unix))]
pub(super) fn observe_spawned_child(child: &Child, command_target: &std::path::Path) {
    if let Some(observer) = take_spawn_child_observer(command_target) {
        observer(child.id());
    }
}

#[cfg(all(test, unix))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum TerminateFailure {
    QuitKillReap,
    ReapTimeout,
    ReapError,
}

#[cfg(all(test, unix))]
std::thread_local! {
    pub(super) static TERMINATE_FAILURE: std::cell::RefCell<Option<TerminateFailure>> =
        const { std::cell::RefCell::new(None) };
}

#[cfg(all(test, unix))]
pub(super) fn set_terminate_failure(failure: Option<TerminateFailure>) {
    TERMINATE_FAILURE.with(|slot| *slot.borrow_mut() = failure);
}

#[cfg(all(test, unix))]
pub(super) fn take_terminate_failure() -> Option<TerminateFailure> {
    TERMINATE_FAILURE.with(|slot| slot.borrow_mut().take())
}

pub(super) async fn complete_exchange<T>(
    runtime: &mut EngineRuntime,
    registration_identity: &OnceLock<(EngineKey, u64)>,
    result: Result<T, Error>,
    reply: oneshot::Sender<Result<T, Error>>,
    recover_on: impl FnOnce(&Error) -> bool,
) -> bool {
    let terminated = result.as_ref().is_err_and(recover_on);
    let result = if terminated {
        recover_failed_protocol(runtime, registration_identity, result).await
    } else {
        result
    };
    let _ = reply.send(result);
    terminated
}

pub(super) fn exchange_failed_protocol(error: &Error) -> bool {
    error.is_engine_failure() || matches!(error, Error::EngineTimeout(_))
}

pub(super) async fn engine_actor_loop(
    mut runtime: EngineRuntime,
    mut rx: mpsc::Receiver<EngineCommand>,
    mut control_rx: mpsc::Receiver<EngineCommand>,
    interrupt: CancellationToken,
    registration_identity: Arc<OnceLock<(EngineKey, u64)>>,
) {
    let mut terminated = false;
    while let Some(command) = tokio::select! {
        biased;
        command = control_rx.recv() => command,
        command = rx.recv() => command,
    } {
        match command {
            EngineCommand::Init(reply) => {
                let result = runtime.init_uci_cancellable(&interrupt).await;
                if complete_exchange(&mut runtime, &registration_identity, result, reply, |_| {
                    true
                })
                .await
                {
                    terminated = true;
                    break;
                }
            }
            EngineCommand::ConfigureStart(reply) => {
                let result = runtime.start_uci_configuration(Some(&interrupt)).await;
                if complete_exchange(&mut runtime, &registration_identity, result, reply, |_| {
                    true
                })
                .await
                {
                    terminated = true;
                    break;
                }
            }
            EngineCommand::ConfigureNext(reply) => {
                let result = runtime
                    .next_configuration_line_cancellable(&interrupt)
                    .await;
                if complete_exchange(&mut runtime, &registration_identity, result, reply, |_| {
                    true
                })
                .await
                {
                    terminated = true;
                    break;
                }
            }
            EngineCommand::SetOption {
                name,
                value,
                resource_values,
                operation_cancellation,
                reply,
            } => {
                let result = runtime
                    .set_option_with_resources(
                        &name,
                        &value,
                        &resource_values,
                        operation_cancellation.as_ref(),
                        Some(&interrupt),
                    )
                    .await;
                if complete_exchange(
                    &mut runtime,
                    &registration_identity,
                    result,
                    reply,
                    exchange_failed_protocol,
                )
                .await
                {
                    terminated = true;
                    break;
                }
            }
            EngineCommand::SetPosition { fen, moves, reply } => {
                let result = runtime.set_position(&fen, &moves, Some(&interrupt)).await;
                if complete_exchange(
                    &mut runtime,
                    &registration_identity,
                    result,
                    reply,
                    exchange_failed_protocol,
                )
                .await
                {
                    terminated = true;
                    break;
                }
            }
            EngineCommand::EnsureReady(reply) => {
                let result = runtime.ensure_ready(Some(&interrupt)).await;
                if complete_exchange(&mut runtime, &registration_identity, result, reply, |_| {
                    true
                })
                .await
                {
                    terminated = true;
                    break;
                }
            }
            EngineCommand::StartSearch { mode, reply } => {
                let started = runtime.start_search(&mode, Some(&interrupt)).await;
                if complete_exchange(&mut runtime, &registration_identity, started, reply, |_| {
                    true
                })
                .await
                {
                    terminated = true;
                    break;
                }
            }
            EngineCommand::NextSearch { id, reply } => {
                if !service_search_read(
                    &mut runtime,
                    id,
                    reply,
                    &mut rx,
                    &mut control_rx,
                    &registration_identity,
                    &interrupt,
                )
                .await
                {
                    terminated = true;
                    break;
                }
            }
            EngineCommand::Stop(reply) => {
                let result =
                    stop_at_protocol_boundary(&mut runtime, &registration_identity, &interrupt)
                        .await;
                let failed = result.is_err();
                let _ = reply.send(result);
                if failed {
                    terminated = true;
                    break;
                }
            }
            EngineCommand::StopRequest { id, reply } => {
                let result = if matches!(runtime.state, EngineState::Searching { request_id } | EngineState::Stopping { request_id } if request_id == id)
                {
                    stop_at_protocol_boundary(&mut runtime, &registration_identity, &interrupt)
                        .await
                } else {
                    Ok(())
                };
                let failed = result.is_err();
                let _ = reply.send(result);
                if failed {
                    terminated = true;
                    break;
                }
            }
            EngineCommand::Terminate(reply) => {
                terminate_and_reply(&mut runtime, &registration_identity, reply).await;
                terminated = true;
                break;
            }
            EngineCommand::Logs(reply) => {
                let _ = reply.send(runtime.logs.entries());
            }
        }
    }
    if !terminated {
        let _ = terminate_and_log(&mut runtime, &registration_identity).await;
    }
}

pub(super) async fn terminate_and_log(
    runtime: &mut EngineRuntime,
    registration_identity: &OnceLock<(EngineKey, u64)>,
) -> Result<(), Error> {
    let result = runtime.terminate().await;
    if let Err(error) = &result {
        log_actor_cleanup_failure(registration_identity, error);
    }
    result
}

pub(super) async fn terminate_and_reply(
    runtime: &mut EngineRuntime,
    registration_identity: &OnceLock<(EngineKey, u64)>,
    reply: oneshot::Sender<Result<(), Error>>,
) {
    let result = terminate_and_log(runtime, registration_identity).await;
    let _ = reply.send(result);
}

pub(super) fn log_actor_cleanup_failure(
    registration_identity: &OnceLock<(EngineKey, u64)>,
    error: &Error,
) {
    match registration_identity.get() {
        Some((key, generation)) => {
            log_registration_cleanup_error(Some(key), Some(*generation), error);
        }
        None => log_registration_cleanup_error(None, None, error),
    }
}

/// A failed protocol exchange means stdout can no longer be trusted as a
/// boundary for another request. Reap the process before replying and
/// permanently close this actor rather than reusing the stream.
pub(super) async fn recover_failed_protocol<T>(
    runtime: &mut EngineRuntime,
    registration_identity: &OnceLock<(EngineKey, u64)>,
    result: Result<T, Error>,
) -> Result<T, Error> {
    match result {
        Ok(value) => Ok(value),
        Err(primary) => {
            let unexpected =
                primary.is_engine_failure() || matches!(primary, Error::EngineTimeout(_));
            let mut snapshot = if unexpected {
                let kind = match &primary {
                    Error::EngineFailure { cause, .. }
                        if matches!(cause.as_ref(), Error::EngineDisconnected) =>
                    {
                        EngineFailureKind::Disconnected
                    }
                    _ => EngineFailureKind::ProtocolFailure,
                };
                Some(
                    runtime
                        .diagnostics
                        .lock()
                        .await
                        .snapshot(kind, runtime.io.observed_exit()),
                )
            } else {
                None
            };
            let termination = runtime.terminate().await;
            if unexpected {
                runtime.drain_terminal_stdout(registration_identity).await;
            }
            let primary = if let Some(mut captured) = snapshot.take() {
                // The existing reap observes status and the bounded stderr join
                // supplies final pipe output. A forced kill is not exit evidence.
                captured.exit_status = runtime.io.observed_exit().or(captured.exit_status);
                if captured.kind == EngineFailureKind::Disconnected
                    && captured.exit_status.is_some()
                {
                    captured.kind = EngineFailureKind::ProcessExit;
                }
                let tail = runtime.diagnostics.lock().await;
                captured.reason = tail.last_info.clone().or_else(|| tail.last_stderr.clone());
                captured.entries = tail.entries();
                let _ = runtime.terminal_snapshot.set(captured);
                match primary {
                    Error::EngineFailure { cause, cleanup, .. } => Error::EngineFailure {
                        snapshot: runtime.terminal_snapshot.get().cloned().map(Box::new),
                        cause,
                        cleanup,
                    },
                    primary => Error::EngineFailure {
                        snapshot: runtime.terminal_snapshot.get().cloned().map(Box::new),
                        cause: Box::new(primary),
                        cleanup: None,
                    },
                }
            } else {
                primary
            };
            if let Err(error) = &termination {
                log_actor_cleanup_failure(registration_identity, error);
            }
            Err(Error::with_cleanup(primary, termination))
        }
    }
}

pub(super) fn protocol_failure(cause: Error) -> Error {
    Error::EngineFailure {
        snapshot: None,
        cause: Box::new(cause),
        cleanup: None,
    }
}

pub(super) fn disconnected_failure() -> Error {
    protocol_failure(Error::EngineDisconnected)
}

pub(super) async fn stop_at_protocol_boundary(
    runtime: &mut EngineRuntime,
    registration_identity: &OnceLock<(EngineKey, u64)>,
    interrupt: &CancellationToken,
) -> Result<(), Error> {
    let result = runtime.stop_current(Some(interrupt)).await;
    recover_failed_protocol(runtime, registration_identity, result).await
}

pub(super) async fn service_search_read(
    runtime: &mut EngineRuntime,
    id: EngineRequestId,
    mut reply: oneshot::Sender<Result<Option<String>, Error>>,
    rx: &mut mpsc::Receiver<EngineCommand>,
    control_rx: &mut mpsc::Receiver<EngineCommand>,
    registration_identity: &OnceLock<(EngineKey, u64)>,
    interrupt: &CancellationToken,
) -> bool {
    if runtime.state != (EngineState::Searching { request_id: id })
        && runtime.state != (EngineState::Stopping { request_id: id })
    {
        let _ = reply.send(Ok(None));
        return true;
    }
    loop {
        tokio::select! {
            biased;
            control = control_rx.recv() => match control {
                Some(control) => match control {
                    EngineCommand::Terminate(control_reply) => {
                        terminate_and_reply(runtime, registration_identity, control_reply).await;
                        let _ = reply.send(Err(Error::EngineDisconnected));
                        return false;
                    }
                    EngineCommand::Stop(control_reply) => {
                        let result =
                            stop_at_protocol_boundary(runtime, registration_identity, interrupt).await;
                        return reply_to_stopped_search(result, reply, control_reply);
                    }
                    EngineCommand::StopRequest { id: target, reply: control_reply } => {
                        if target != id {
                            let _ = control_reply.send(Ok(()));
                            continue;
                        }
                        let result = stop_at_protocol_boundary(runtime, registration_identity, interrupt).await;
                        return reply_to_stopped_search(result, reply, control_reply);
                    }
                    EngineCommand::Logs(control_reply) => {
                        let _ = control_reply.send(runtime.logs.entries());
                    }
                    other => reject_command_during_search(other),
                },
                None => {
                    let _ = terminate_and_log(runtime, registration_identity).await;
                    let _ = reply.send(Err(Error::EngineDisconnected));
                    return false;
                }
            },
            _ = reply.closed() => {
                return true;
            }
            result = timeout(runtime.deadlines.search, runtime.read_line()) => {
                let result = match result {
                    Ok(Ok(Some(line))) => {
                        if matches!(vampirc_uci::parse_one(&line), UciMessage::BestMove { .. }) {
                            runtime.state = EngineState::Idle;
                        }
                        Ok(Some(line))
                    }
                    Ok(Ok(None)) => {
                        runtime.state = EngineState::Idle;
                        Err(disconnected_failure())
                    }
                    Ok(Err(error)) => Err(error),
                    Err(_) => Err(Error::EngineTimeout("waiting for engine search output".into())),
                };
                let failed = result.is_err();
                let result = recover_failed_protocol(runtime, registration_identity, result).await;
                let _ = reply.send(result);
                return !failed;
            }
            command = rx.recv() => match command {
                Some(EngineCommand::Terminate(control_reply)) => {
                    terminate_and_reply(runtime, registration_identity, control_reply).await;
                    let _ = reply.send(Err(Error::EngineDisconnected));
                    return false;
                }
                Some(EngineCommand::Stop(control_reply)) => {
                    let result = stop_at_protocol_boundary(runtime, registration_identity, interrupt).await;
                    return reply_to_stopped_search(result, reply, control_reply);
                }
                Some(EngineCommand::Logs(control_reply)) => {
                    // Logs are observational. They must remain available while
                    // stdout is silent without cancelling the active search.
                    let _ = control_reply.send(runtime.logs.entries());
                }
                Some(EngineCommand::NextSearch { id: requested, reply: next_reply }) if requested != id => {
                    let _ = next_reply.send(Ok(None));
                }
                Some(other) => reject_command_during_search(other),
                None => {
                    let _ = terminate_and_log(runtime, registration_identity).await;
                    let _ = reply.send(Err(Error::EngineDisconnected));
                    return false;
                }
            }
        }
    }
}

pub(super) fn reply_to_stopped_search(
    result: Result<(), Error>,
    reply: oneshot::Sender<Result<Option<String>, Error>>,
    control_reply: oneshot::Sender<Result<(), Error>>,
) -> bool {
    match result {
        Ok(()) => {
            let _ = reply.send(Ok(None));
            let _ = control_reply.send(Ok(()));
            true
        }
        Err(error) if error.is_engine_failure() => {
            let error = Arc::new(error);
            let _ = reply.send(Err(Error::Shared(error.clone())));
            let _ = control_reply.send(Err(Error::Shared(error)));
            false
        }
        Err(error) => {
            let _ = reply.send(Err(Error::EngineDisconnected));
            let _ = control_reply.send(Err(error));
            false
        }
    }
}

pub(super) fn reject_command_during_search(command: EngineCommand) {
    let error = || Error::Conflict("engine is busy searching; stop or terminate it first".into());
    match command {
        EngineCommand::Init(reply)
        | EngineCommand::ConfigureStart(reply)
        | EngineCommand::EnsureReady(reply) => {
            let _ = reply.send(Err(error()));
        }
        EngineCommand::ConfigureNext(reply) | EngineCommand::NextSearch { reply, .. } => {
            let _ = reply.send(Err(error()));
        }
        EngineCommand::SetOption { reply, .. } | EngineCommand::SetPosition { reply, .. } => {
            let _ = reply.send(Err(error()));
        }
        EngineCommand::StartSearch { reply, .. } => {
            let _ = reply.send(Err(error()));
        }
        EngineCommand::Stop(reply) | EngineCommand::StopRequest { reply, .. } => {
            let _ = reply.send(Err(error()));
        }
        EngineCommand::Terminate(reply) => {
            let _ = reply.send(Err(error()));
        }
        EngineCommand::Logs(reply) => {
            let _ = reply.send(Vec::new());
        }
    }
}
