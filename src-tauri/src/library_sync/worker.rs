//! Single-actor Library sync worker, lifecycle, scheduling and event throttling (S-5, S-6).

use crate::{
    chessriddle::{AccountError, AccountOwner},
    infra::{
        blocking::BLOCKING_GATEWAY,
        path_authority::{
            ensure_app_owned_default_dir, AppDataDir, AppOwnedDefaultRoot, AuthorizedDir,
            FileWorkspaceHandle, SharedPathAuthority,
        },
    },
    library_sync::{
        planner::{plan_reconcile, SyncAction},
        scan::{
            has_unmatched_entries, match_candidates_to_entries, read_candidate_bytes_blocking,
            scan_workspace_blocking, CandidateFingerprint, ScanResult, ScannedCandidate,
        },
        state::{FileRejection, StoredLocator, SyncEntry, SyncMode, SyncState},
        wire::{
            LibraryFileKind, LibraryPrecondition, LibraryPutResponse, LibraryRequestError,
            StudioLibraryList,
        },
        LibrarySyncChanged, LibrarySyncError, LibrarySyncFile, LibrarySyncFileStatus,
        LibrarySyncSnapshot, LibrarySyncState, LibrarySyncTurnOffMode, ABSENCE_DELETE_THRESHOLD,
    },
};
use std::{
    collections::{HashMap, HashSet},
    ffi::OsString,
    future::Future,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri_specta::Event as _;
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;

const WORKER_QUEUE_CAPACITY: usize = 32;
const DEFAULT_SCAN_INTERVAL: Duration = Duration::from_secs(20);
const DEFAULT_BACKOFF_BASE: Duration = Duration::from_secs(30);
const DEFAULT_BACKOFF_MAX: Duration = Duration::from_secs(15 * 60);
const DEFAULT_BUSY_RETRY_WAIT: Duration = Duration::from_secs(1);
const DEFAULT_EVENT_MIN_INTERVAL: Duration = Duration::from_millis(250);
const MAX_TRANSIENT_RETRIES: u32 = 5;

type EventEmitter = Arc<dyn Fn(LibrarySyncChanged) + Send + Sync>;

#[derive(Clone, Debug)]
struct WorkerConfig {
    scan_interval: Duration,
    backoff_base: Duration,
    backoff_max: Duration,
    busy_retry_wait: Duration,
    event_min_interval: Duration,
    /// Optional cap on server `Retry-After` waits in tests.
    retry_after_cap: Option<Duration>,
}

impl Default for WorkerConfig {
    fn default() -> Self {
        Self {
            scan_interval: DEFAULT_SCAN_INTERVAL,
            backoff_base: DEFAULT_BACKOFF_BASE,
            backoff_max: DEFAULT_BACKOFF_MAX,
            busy_retry_wait: DEFAULT_BUSY_RETRY_WAIT,
            event_min_interval: DEFAULT_EVENT_MIN_INTERVAL,
            retry_after_cap: None,
        }
    }
}

/// Shared pure mapping from one scanned candidate to its per-file status.
fn candidate_file_status(
    candidate: &ScannedCandidate,
    selected: bool,
    entry: Option<&SyncEntry>,
    override_status: Option<&LibrarySyncFileStatus>,
    default_selected_status: LibrarySyncFileStatus,
) -> LibrarySyncFileStatus {
    if !selected {
        return LibrarySyncFileStatus::NotSelected;
    }
    if candidate.oversized {
        return LibrarySyncFileStatus::TooLarge;
    }
    if candidate.unreadable {
        return LibrarySyncFileStatus::Unreadable;
    }
    if let Some(status) = override_status {
        return status.clone();
    }
    if let Some(rej) = entry.and_then(|e| e.last_rejection.as_ref()) {
        if candidate.content_sha256.as_deref() == Some(rej.content_sha256.as_str())
            && rej.code.is_file_intrinsic()
        {
            return rej.code.to_file_status(rej.game_number);
        }
    }
    default_selected_status
}

fn resolve_account_connected(result: Result<bool, AccountError>, last_known: bool) -> bool {
    match result {
        Ok(connected) => connected,
        Err(AccountError::Busy | AccountError::Storage) => last_known,
        Err(_) => false,
    }
}

/// Shared active-mode snapshot projection for both `LibrarySyncOwner::snapshot` and
/// `SyncActor::current_snapshot_for`. Removing mode (and any state pausing it) applies across
/// every workspace; active sync for another folder reports `OtherFolder`.
fn project_active_snapshot(
    mode: SyncMode,
    synced_workspace: Option<&FileWorkspaceHandle>,
    workspace: FileWorkspaceHandle,
    revision: u32,
    available: bool,
    overall_state: LibrarySyncState,
    files: Vec<LibrarySyncFile>,
) -> LibrarySyncSnapshot {
    let same_workspace = synced_workspace == Some(&workspace);
    if mode == SyncMode::Removing || same_workspace {
        LibrarySyncSnapshot {
            workspace,
            revision,
            available,
            state: overall_state,
            files: if same_workspace { files } else { Vec::new() },
        }
    } else {
        LibrarySyncSnapshot {
            workspace,
            revision,
            available: true,
            state: LibrarySyncState::OtherFolder,
            files: Vec::new(),
        }
    }
}

fn off_files_from_candidates(candidates: &[ScannedCandidate]) -> Vec<LibrarySyncFile> {
    candidates
        .iter()
        .map(|c| LibrarySyncFile {
            handle: c.handle.clone(),
            name: c.name.clone(),
            folder_label: c.folder_label.clone(),
            selected: true,
            status: candidate_file_status(c, true, None, None, LibrarySyncFileStatus::Pending),
        })
        .collect()
}

enum WorkerMessage {
    TurnOn {
        workspace: FileWorkspaceHandle,
        deselected: Vec<FileWorkspaceHandle>,
        reply: oneshot::Sender<Result<LibrarySyncSnapshot, LibrarySyncError>>,
    },
    TurnOff {
        workspace: FileWorkspaceHandle,
        mode: LibrarySyncTurnOffMode,
        reply: oneshot::Sender<Result<LibrarySyncSnapshot, LibrarySyncError>>,
    },
    SetFileSelected {
        workspace: FileWorkspaceHandle,
        file: FileWorkspaceHandle,
        selected: bool,
        reply: oneshot::Sender<Result<LibrarySyncSnapshot, LibrarySyncError>>,
    },
    SyncNow {
        workspace: FileWorkspaceHandle,
        reply: oneshot::Sender<Result<LibrarySyncSnapshot, LibrarySyncError>>,
    },
    AccountConnected,
    AccountDisconnected,
}

#[derive(Clone)]
struct PublishedView {
    revision: u32,
    account_connected: bool,
    account_matches: bool,
    mode: SyncMode,
    synced_workspace: Option<FileWorkspaceHandle>,
    overall_state: LibrarySyncState,
    files: Vec<LibrarySyncFile>,
}

impl PublishedView {
    fn from_state(state: &SyncState, account_connected: bool) -> Self {
        let overall_state = match state.mode {
            SyncMode::Off => LibrarySyncState::Off,
            SyncMode::On => LibrarySyncState::Synced,
            SyncMode::Removing => LibrarySyncState::Removing {
                done: 0,
                total: state.entries.len().min(u32::MAX as usize) as u32,
            },
        };
        Self {
            revision: 1,
            account_connected,
            account_matches: true,
            mode: state.mode,
            synced_workspace: state.workspace.clone(),
            overall_state,
            files: Vec::new(),
        }
    }

    fn effective_active(&self) -> bool {
        self.mode != SyncMode::Off && self.account_matches
    }

    fn available(&self) -> bool {
        self.account_connected || self.effective_active()
    }
}

struct ActorDeps {
    state_dir: Arc<AuthorizedDir>,
    authority: SharedPathAuthority,
    workspace_mutation: Arc<Mutex<()>>,
    account: Arc<std::sync::OnceLock<AccountOwner>>,
    published: Arc<Mutex<PublishedView>>,
    emit: EventEmitter,
    config: WorkerConfig,
    cancel: CancellationToken,
}

pub(crate) struct LibrarySyncOwner {
    sender: mpsc::Sender<WorkerMessage>,
    cancel: CancellationToken,
    join: tokio::sync::Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    published: Arc<Mutex<PublishedView>>,
    authority: SharedPathAuthority,
    workspace_mutation: Arc<Mutex<()>>,
    account: Arc<std::sync::OnceLock<AccountOwner>>,
}

impl LibrarySyncOwner {
    fn start(
        state_dir: Arc<AuthorizedDir>,
        initial_state: SyncState,
        authority: SharedPathAuthority,
        workspace_mutation: Arc<Mutex<()>>,
        account: Arc<std::sync::OnceLock<AccountOwner>>,
        emit: EventEmitter,
        config: WorkerConfig,
    ) -> Self {
        let cancel = CancellationToken::new();
        let (sender, receiver) = mpsc::channel(WORKER_QUEUE_CAPACITY);
        let published = Arc::new(Mutex::new(PublishedView::from_state(&initial_state, false)));
        let deps = ActorDeps {
            state_dir,
            authority: authority.clone(),
            workspace_mutation: Arc::clone(&workspace_mutation),
            account: Arc::clone(&account),
            published: Arc::clone(&published),
            emit,
            config,
            cancel: cancel.clone(),
        };
        let join = tauri::async_runtime::spawn(async move {
            let mut actor = SyncActor::new(deps, initial_state);
            actor.run_loop(receiver).await;
        });
        Self {
            sender,
            cancel,
            join: tokio::sync::Mutex::new(Some(join)),
            published,
            authority,
            workspace_mutation,
            account,
        }
    }

    pub(crate) fn notify_account_connected(&self) {
        if let Err(error) = self.sender.try_send(WorkerMessage::AccountConnected) {
            log::warn!("library sync worker could not accept connect notification: {error}");
        }
    }

    pub(crate) fn notify_account_disconnected(&self) {
        if let Err(error) = self.sender.try_send(WorkerMessage::AccountDisconnected) {
            log::warn!("library sync worker could not accept disconnect notification: {error}");
        }
    }

    pub(crate) async fn shutdown(&self) {
        self.cancel.cancel();
        let handle = self.join.lock().await.take();
        if let Some(handle) = handle {
            let _ = handle.await;
        }
    }

    pub(crate) async fn snapshot(
        &self,
        workspace: FileWorkspaceHandle,
    ) -> Result<LibrarySyncSnapshot, LibrarySyncError> {
        let view = self
            .published
            .lock()
            .map_err(|_| LibrarySyncError::Unavailable)?
            .clone();

        if view.effective_active() {
            return Ok(project_active_snapshot(
                view.mode,
                view.synced_workspace.as_ref(),
                workspace,
                view.revision,
                view.available(),
                view.overall_state,
                view.files,
            ));
        }

        // Sync is off (or bound to a different account): check account availability without
        // collapsing transient Busy/Storage errors into "not connected", and scan the shown
        // folder reporting FolderUnavailable if the scan fails.
        let account_connected = match self.account.get() {
            Some(owner) if owner.is_available() => {
                resolve_account_connected(owner.is_connected().await, view.account_connected)
            }
            _ => false,
        };
        let authority = self.authority.clone();
        let mutation = Arc::clone(&self.workspace_mutation);
        let ws = workspace.clone();
        let cancel = self.cancel.clone();
        let scan = BLOCKING_GATEWAY
            .spawn_cancellable(cancel, move |token| {
                scan_workspace_blocking(&authority, &mutation, &ws, &HashMap::new(), token)
            })
            .await;

        let (state, files) = match scan {
            Ok(result) => (
                LibrarySyncState::Off,
                off_files_from_candidates(&result.candidates),
            ),
            Err(_) => (LibrarySyncState::FolderUnavailable, Vec::new()),
        };

        Ok(LibrarySyncSnapshot {
            workspace,
            revision: view.revision,
            available: account_connected,
            state,
            files,
        })
    }

    async fn send_command(
        &self,
        build: impl FnOnce(
            oneshot::Sender<Result<LibrarySyncSnapshot, LibrarySyncError>>,
        ) -> WorkerMessage,
    ) -> Result<LibrarySyncSnapshot, LibrarySyncError> {
        let (reply, rx) = oneshot::channel();
        self.sender
            .try_send(build(reply))
            .map_err(|_| LibrarySyncError::Busy)?;
        rx.await.map_err(|_| LibrarySyncError::Unavailable)?
    }

    pub(crate) async fn turn_on(
        &self,
        workspace: FileWorkspaceHandle,
        deselected: Vec<FileWorkspaceHandle>,
    ) -> Result<LibrarySyncSnapshot, LibrarySyncError> {
        self.send_command(|reply| WorkerMessage::TurnOn {
            workspace,
            deselected,
            reply,
        })
        .await
    }

    pub(crate) async fn turn_off(
        &self,
        workspace: FileWorkspaceHandle,
        mode: LibrarySyncTurnOffMode,
    ) -> Result<LibrarySyncSnapshot, LibrarySyncError> {
        self.send_command(|reply| WorkerMessage::TurnOff {
            workspace,
            mode,
            reply,
        })
        .await
    }

    pub(crate) async fn set_file_selected(
        &self,
        workspace: FileWorkspaceHandle,
        file: FileWorkspaceHandle,
        selected: bool,
    ) -> Result<LibrarySyncSnapshot, LibrarySyncError> {
        self.send_command(|reply| WorkerMessage::SetFileSelected {
            workspace,
            file,
            selected,
            reply,
        })
        .await
    }

    pub(crate) async fn sync_now(
        &self,
        workspace: FileWorkspaceHandle,
    ) -> Result<LibrarySyncSnapshot, LibrarySyncError> {
        self.send_command(|reply| WorkerMessage::SyncNow { workspace, reply })
            .await
    }
}

pub(crate) fn initialize(
    app: &tauri::AppHandle,
    state: &crate::AppState,
) -> Result<LibrarySyncOwner, crate::error::Error> {
    let app_handle = app.clone();
    let (state_dir, initial_state) = tauri::async_runtime::block_on(
        BLOCKING_GATEWAY.spawn_cancellable(CancellationToken::new(), move |_| {
            let app_data = AppDataDir::for_app(&app_handle)?;
            let dir = ensure_app_owned_default_dir(&app_data, AppOwnedDefaultRoot::LibrarySync)?;
            let loaded = SyncState::load(&dir);
            Ok((Arc::new(dir), loaded))
        }),
    )?;

    let emit_app = app.clone();
    let emit: EventEmitter = Arc::new(move |event| {
        if let Err(error) = event.emit(&emit_app) {
            log::warn!("could not emit library sync change event: {error}");
        }
    });

    Ok(LibrarySyncOwner::start(
        state_dir,
        initial_state,
        state.pgn_path_authority.clone(),
        Arc::clone(&state.workspace_mutation),
        Arc::clone(&state.chessriddle),
        emit,
        WorkerConfig::default(),
    ))
}

pub(crate) async fn shutdown(state: &crate::AppState) {
    if let Some(owner) = state.library_sync.get() {
        owner.shutdown().await;
    }
}

enum RunOutcome {
    Done,
    Interrupted,
    ScheduleBackoff,
    ImmediateRerun,
    StopUntilTrigger,
}

struct PutTarget {
    studio_file_id: String,
    handle: FileWorkspaceHandle,
    name: String,
    kind: LibraryFileKind,
    precondition: LibraryPrecondition,
}

struct SyncActor {
    state_dir: Arc<AuthorizedDir>,
    state: SyncState,
    authority: SharedPathAuthority,
    workspace_mutation: Arc<Mutex<()>>,
    account: Arc<std::sync::OnceLock<AccountOwner>>,
    published: Arc<Mutex<PublishedView>>,
    emit: EventEmitter,
    config: WorkerConfig,
    cancel: CancellationToken,

    account_connected: bool,
    account_matches: bool,
    overall_state: LibrarySyncState,
    last_candidates: Vec<ScannedCandidate>,
    last_matched_ids: Vec<Option<String>>,
    last_fingerprints: Option<Vec<CandidateFingerprint>>,
    hash_cache: HashMap<Vec<OsString>, (String, String)>,
    file_statuses: HashMap<String, LibrarySyncFileStatus>,
    pending_deselected_handles: HashSet<FileWorkspaceHandle>,
    last_complete_scan_at: Option<Instant>,
    backoff_step: u32,
    next_backoff_at: Option<Instant>,
    next_scan_at: Option<Instant>,
    run_requested: bool,
    paused_until_trigger: bool,
    unsupported_server: bool,

    revision: u32,
    last_emit_at: Option<Instant>,
    pending_emit_revision: Option<u32>,
}

impl SyncActor {
    fn new(deps: ActorDeps, initial_state: SyncState) -> Self {
        let initial_mode = initial_state.mode;
        let overall_state = match initial_mode {
            SyncMode::Off => LibrarySyncState::Off,
            SyncMode::On => LibrarySyncState::Synced,
            SyncMode::Removing => LibrarySyncState::Removing {
                done: 0,
                total: initial_state.entries.len().min(u32::MAX as usize) as u32,
            },
        };
        Self {
            state_dir: deps.state_dir,
            state: initial_state,
            authority: deps.authority,
            workspace_mutation: deps.workspace_mutation,
            account: deps.account,
            published: deps.published,
            emit: deps.emit,
            config: deps.config,
            cancel: deps.cancel,
            account_connected: false,
            account_matches: true,
            overall_state,
            last_candidates: Vec::new(),
            last_matched_ids: Vec::new(),
            last_fingerprints: None,
            hash_cache: HashMap::new(),
            file_statuses: HashMap::new(),
            pending_deselected_handles: HashSet::new(),
            last_complete_scan_at: None,
            backoff_step: 0,
            next_backoff_at: None,
            next_scan_at: None,
            run_requested: initial_mode != SyncMode::Off,
            paused_until_trigger: false,
            unsupported_server: false,
            revision: 1,
            last_emit_at: None,
            pending_emit_revision: None,
        }
    }

    async fn run_loop(&mut self, mut receiver: mpsc::Receiver<WorkerMessage>) {
        self.refresh_account_connected().await;
        self.publish(false);

        loop {
            if self.cancel.is_cancelled() {
                break;
            }

            while let Ok(msg) = receiver.try_recv() {
                self.handle_message(msg).await;
                if self.cancel.is_cancelled() {
                    return;
                }
            }

            self.flush_pending_emit_if_due();

            if self.run_requested && self.state.mode != SyncMode::Off {
                self.run_requested = false;
                self.next_backoff_at = None;
                let outcome = match self.state.mode {
                    SyncMode::On => self.execute_sync_run(&mut receiver).await,
                    SyncMode::Removing => self.execute_removing_run(&mut receiver).await,
                    SyncMode::Off => RunOutcome::Done,
                };
                if self.cancel.is_cancelled() {
                    break;
                }
                match outcome {
                    RunOutcome::Done => {
                        self.backoff_step = 0;
                        self.next_backoff_at = None;
                        self.paused_until_trigger = false;
                        if self.state.mode == SyncMode::On {
                            self.next_scan_at = Some(Instant::now() + self.config.scan_interval);
                        } else {
                            self.next_scan_at = None;
                        }
                    }
                    // A control message (such as AccountDisconnected) interrupted the run; preserve
                    // whatever pause/run/timer flags that handler set.
                    RunOutcome::Interrupted => {}
                    RunOutcome::ImmediateRerun => {
                        self.run_requested = true;
                    }
                    RunOutcome::ScheduleBackoff => {
                        let delay = self.next_backoff_delay();
                        self.next_backoff_at = Some(Instant::now() + delay);
                        if self.state.mode == SyncMode::On {
                            self.next_scan_at = Some(Instant::now() + self.config.scan_interval);
                        }
                    }
                    RunOutcome::StopUntilTrigger => {
                        self.paused_until_trigger = true;
                        self.next_backoff_at = None;
                        self.next_scan_at = None;
                    }
                }
                continue;
            }

            let now = Instant::now();
            let emit_due = self
                .pending_emit_revision
                .and(self.last_emit_at)
                .map(|last| last + self.config.event_min_interval);
            let backoff_due = if self.state.mode != SyncMode::Off && !self.paused_until_trigger {
                self.next_backoff_at
            } else {
                None
            };
            let scan_due = if self.state.mode == SyncMode::On
                && !self.paused_until_trigger
                && !self.unsupported_server
                && self.account_matches
            {
                self.next_scan_at
            } else {
                None
            };

            let next_deadline = [emit_due, backoff_due, scan_due]
                .into_iter()
                .flatten()
                .min();

            match next_deadline {
                Some(deadline) => {
                    let wait = deadline.saturating_duration_since(now);
                    tokio::select! {
                        biased;
                        _ = self.cancel.cancelled() => break,
                        msg = receiver.recv() => {
                            match msg {
                                Some(msg) => self.handle_message(msg).await,
                                None => break,
                            }
                        }
                        _ = tokio::time::sleep(wait) => {
                            self.flush_pending_emit_if_due();
                            let now = Instant::now();
                            if self.next_backoff_at.is_some_and(|t| now >= t) {
                                self.next_backoff_at = None;
                                self.run_requested = true;
                            } else if self.next_scan_at.is_some_and(|t| now >= t) {
                                self.next_scan_at = None;
                                self.periodic_scan_check().await;
                            }
                        }
                    }
                }
                None => {
                    tokio::select! {
                        biased;
                        _ = self.cancel.cancelled() => break,
                        msg = receiver.recv() => {
                            match msg {
                                Some(msg) => self.handle_message(msg).await,
                                None => break,
                            }
                        }
                    }
                }
            }
        }
    }

    fn next_backoff_delay(&mut self) -> Duration {
        let shift = self.backoff_step.min(10);
        let factor = 1u32.checked_shl(shift).unwrap_or(u32::MAX);
        let delay = self
            .config
            .backoff_base
            .saturating_mul(factor)
            .min(self.config.backoff_max);
        self.backoff_step = self.backoff_step.saturating_add(1);
        delay
    }

    async fn refresh_account_connected(&mut self) {
        self.account_connected = match self.account.get() {
            Some(owner) if owner.is_available() => {
                tokio::select! {
                    biased;
                    _ = self.cancel.cancelled() => self.account_connected,
                    res = owner.is_connected() => {
                        resolve_account_connected(res, self.account_connected)
                    }
                }
            }
            _ => false,
        };
    }

    fn is_pending_deselected(&self, candidate: &ScannedCandidate) -> bool {
        self.pending_deselected_handles.contains(&candidate.handle)
            || self
                .state
                .pending_deselected_locators
                .iter()
                .any(|stored| stored.0 == candidate.locator)
    }

    fn build_files_view(&self) -> Vec<LibrarySyncFile> {
        let mut out = Vec::with_capacity(self.last_candidates.len());
        for (idx, candidate) in self.last_candidates.iter().enumerate() {
            let entry_id = self.last_matched_ids.get(idx).and_then(|id| id.as_ref());
            let entry = entry_id.and_then(|id| self.state.entries.get(id));
            let selected = match entry {
                Some(entry) => entry.selected,
                None => !self.is_pending_deselected(candidate),
            };
            let override_status = entry_id.and_then(|id| self.file_statuses.get(id));
            let status = candidate_file_status(
                candidate,
                selected,
                entry,
                override_status,
                LibrarySyncFileStatus::Pending,
            );
            out.push(LibrarySyncFile {
                handle: candidate.handle.clone(),
                name: candidate.name.clone(),
                folder_label: candidate.folder_label.clone(),
                selected,
                status,
            });
        }
        out
    }

    fn current_snapshot_for(&self, workspace: FileWorkspaceHandle) -> LibrarySyncSnapshot {
        let effective_active = self.state.mode != SyncMode::Off && self.account_matches;
        if effective_active {
            return project_active_snapshot(
                self.state.mode,
                self.state.workspace.as_ref(),
                workspace,
                self.revision,
                true,
                self.overall_state.clone(),
                self.build_files_view(),
            );
        }
        LibrarySyncSnapshot {
            workspace,
            revision: self.revision,
            available: self.account_connected,
            state: self.overall_state.clone(),
            files: self.build_files_view(),
        }
    }

    fn publish(&mut self, emit_change: bool) {
        if emit_change {
            self.revision = self.revision.wrapping_add(1).max(1);
        }
        let files = self.build_files_view();
        if let Ok(mut view) = self.published.lock() {
            view.revision = self.revision;
            view.account_connected = self.account_connected;
            view.account_matches = self.account_matches;
            view.mode = self.state.mode;
            view.synced_workspace = self.state.workspace.clone();
            view.overall_state = self.overall_state.clone();
            view.files = files;
        }
        if emit_change {
            self.schedule_emit(self.revision);
        }
    }

    fn schedule_emit(&mut self, revision: u32) {
        let now = Instant::now();
        let can_emit_now = self
            .last_emit_at
            .is_none_or(|last| now.duration_since(last) >= self.config.event_min_interval);
        if can_emit_now {
            self.last_emit_at = Some(now);
            self.pending_emit_revision = None;
            (self.emit)(LibrarySyncChanged { revision });
        } else {
            self.pending_emit_revision = Some(revision);
        }
    }

    fn flush_pending_emit_if_due(&mut self) {
        let Some(rev) = self.pending_emit_revision else {
            return;
        };
        let now = Instant::now();
        let due = self
            .last_emit_at
            .is_none_or(|last| now.duration_since(last) >= self.config.event_min_interval);
        if due {
            self.last_emit_at = Some(now);
            self.pending_emit_revision = None;
            (self.emit)(LibrarySyncChanged { revision: rev });
        }
    }

    async fn persist_state(&self, candidate: SyncState) -> Result<(), LibrarySyncError> {
        let dir = Arc::clone(&self.state_dir);
        let cancel = self.cancel.clone();
        BLOCKING_GATEWAY
            .spawn_cancellable(cancel, move |_| candidate.save(&dir))
            .await
            .map_err(|error| {
                log::warn!("library sync state write failed: {error}");
                LibrarySyncError::LocalStorage
            })
    }

    fn enter_local_error(&mut self) -> RunOutcome {
        self.overall_state = LibrarySyncState::LocalError;
        self.publish(true);
        RunOutcome::StopUntilTrigger
    }

    async fn scan_workspace(
        &self,
        workspace: &FileWorkspaceHandle,
    ) -> Result<ScanResult, crate::error::Error> {
        let authority = self.authority.clone();
        let mutation = Arc::clone(&self.workspace_mutation);
        let ws = workspace.clone();
        let hash_cache = self.hash_cache.clone();
        let cancel = self.cancel.clone();
        BLOCKING_GATEWAY
            .spawn_cancellable(cancel, move |token| {
                scan_workspace_blocking(&authority, &mutation, &ws, &hash_cache, token)
            })
            .await
    }

    async fn handle_message(&mut self, msg: WorkerMessage) {
        match msg {
            WorkerMessage::TurnOn {
                workspace,
                deselected,
                reply,
            } => {
                let result = self.handle_turn_on(workspace, deselected).await;
                let _ = reply.send(result);
            }
            WorkerMessage::TurnOff {
                workspace,
                mode,
                reply,
            } => {
                let result = self.handle_turn_off(workspace, mode).await;
                let _ = reply.send(result);
            }
            WorkerMessage::SetFileSelected {
                workspace,
                file,
                selected,
                reply,
            } => {
                let result = self
                    .handle_set_file_selected(workspace, file, selected)
                    .await;
                let _ = reply.send(result);
            }
            WorkerMessage::SyncNow { workspace, reply } => {
                let result = self.handle_sync_now(workspace).await;
                let _ = reply.send(result);
            }
            WorkerMessage::AccountConnected => {
                self.account_connected = true;
                self.paused_until_trigger = false;
                self.unsupported_server = false;
                self.backoff_step = 0;
                self.next_backoff_at = None;
                if self.state.mode != SyncMode::Off {
                    self.run_requested = true;
                }
                self.publish(true);
            }
            WorkerMessage::AccountDisconnected => {
                self.account_connected = false;
                self.run_requested = false;
                self.next_backoff_at = None;
                self.next_scan_at = None;
                if self.state.mode != SyncMode::Off && self.account_matches {
                    self.overall_state = LibrarySyncState::SignInNeeded;
                    self.paused_until_trigger = true;
                }
                self.publish(true);
            }
        }
    }

    async fn handle_turn_on(
        &mut self,
        workspace: FileWorkspaceHandle,
        deselected: Vec<FileWorkspaceHandle>,
    ) -> Result<LibrarySyncSnapshot, LibrarySyncError> {
        self.refresh_account_connected().await;
        let scan = self
            .scan_workspace(&workspace)
            .await
            .map_err(|_| LibrarySyncError::InvalidWorkspace)?;

        // Do not mint ids before the first server list so identity pass 4 can adopt matching
        // server files. Key initial deselections by both handle and locator.
        let deselected_handles: HashSet<FileWorkspaceHandle> = deselected.into_iter().collect();
        let pending_deselected_locators: Vec<StoredLocator> = scan
            .candidates
            .iter()
            .filter(|c| deselected_handles.contains(&c.handle))
            .map(|c| StoredLocator(c.locator.clone()))
            .collect();

        let next_state = SyncState {
            version: crate::library_sync::state::STATE_VERSION,
            account_id: None,
            mode: SyncMode::On,
            workspace: Some(workspace.clone()),
            entries: Default::default(),
            pending_deselected_locators,
        };
        self.persist_state(next_state.clone()).await?;

        self.state = next_state;
        self.pending_deselected_handles = deselected_handles;
        self.account_matches = true;
        self.unsupported_server = false;
        self.paused_until_trigger = false;
        self.backoff_step = 0;
        self.next_backoff_at = None;
        self.last_fingerprints = Some(scan.fingerprints());
        self.last_complete_scan_at = None;
        self.hash_cache = scan.updated_hash_cache;
        self.last_matched_ids = vec![None; scan.candidates.len()];
        self.last_candidates = scan.candidates;
        self.file_statuses.clear();
        self.overall_state = LibrarySyncState::Syncing { done: 0, total: 0 };
        self.run_requested = true;
        self.publish(true);
        Ok(self.current_snapshot_for(workspace))
    }

    async fn handle_turn_off(
        &mut self,
        workspace: FileWorkspaceHandle,
        mode: LibrarySyncTurnOffMode,
    ) -> Result<LibrarySyncSnapshot, LibrarySyncError> {
        match mode {
            LibrarySyncTurnOffMode::Keep => {
                let next_state = SyncState::off();
                self.persist_state(next_state.clone()).await?;
                self.state = next_state;
                self.pending_deselected_handles.clear();
                self.account_matches = true;
                self.file_statuses.clear();
                self.last_matched_ids.clear();
                self.last_fingerprints = None;
                self.last_complete_scan_at = None;
                self.run_requested = false;
                self.next_backoff_at = None;
                self.next_scan_at = None;
                self.paused_until_trigger = false;
                self.refresh_account_connected().await;

                // Return the same off-state snapshot with candidate files as `snapshot`.
                match self.scan_workspace(&workspace).await {
                    Ok(scan) => {
                        self.hash_cache = scan.updated_hash_cache;
                        self.last_candidates = scan.candidates;
                        self.overall_state = LibrarySyncState::Off;
                    }
                    Err(_) => {
                        self.last_candidates.clear();
                        self.overall_state = LibrarySyncState::FolderUnavailable;
                    }
                }
                self.publish(true);
                Ok(self.current_snapshot_for(workspace))
            }
            LibrarySyncTurnOffMode::Remove => {
                let mut next_state = self.state.clone();
                next_state.mode = SyncMode::Removing;
                self.persist_state(next_state.clone()).await?;
                self.state = next_state;
                self.paused_until_trigger = false;
                self.backoff_step = 0;
                self.next_backoff_at = None;
                self.next_scan_at = None;
                let total = self.state.entries.len().min(u32::MAX as usize) as u32;
                self.overall_state = LibrarySyncState::Removing { done: 0, total };
                self.run_requested = true;
                self.publish(true);
                Ok(self.current_snapshot_for(workspace))
            }
        }
    }

    async fn handle_set_file_selected(
        &mut self,
        workspace: FileWorkspaceHandle,
        file: FileWorkspaceHandle,
        selected: bool,
    ) -> Result<LibrarySyncSnapshot, LibrarySyncError> {
        if self.state.mode != SyncMode::On
            || !self.account_matches
            || self.state.workspace.as_ref() != Some(&workspace)
        {
            return Err(LibrarySyncError::NotActive);
        }
        let mut next_state = self.state.clone();
        let mut found_id = next_state
            .entries
            .iter()
            .find(|(_, entry)| entry.handle.as_ref() == Some(&file))
            .map(|(id, _)| id.clone());
        if found_id.is_none() {
            if let Some(idx) = self.last_candidates.iter().position(|c| c.handle == file) {
                found_id = self.last_matched_ids.get(idx).and_then(|id| id.clone());
            }
        }
        if let Some(id) = found_id {
            if let Some(entry) = next_state.entries.get_mut(&id) {
                entry.selected = selected;
            }
            self.persist_state(next_state.clone()).await?;
            self.state = next_state;
            if selected {
                self.file_statuses
                    .insert(id, LibrarySyncFileStatus::Pending);
            } else {
                self.file_statuses
                    .insert(id, LibrarySyncFileStatus::NotSelected);
            }
        } else if let Some(cand) = self.last_candidates.iter().find(|c| c.handle == file) {
            // Selection toggled before the first list minted/adopted entries. Mutate in-memory
            // state only after `persist_state` succeeds (S-2).
            let mut next_pending_handles = self.pending_deselected_handles.clone();
            if selected {
                next_pending_handles.remove(&file);
                next_state
                    .pending_deselected_locators
                    .retain(|stored| stored.0 != cand.locator);
            } else {
                next_pending_handles.insert(file);
                if !next_state
                    .pending_deselected_locators
                    .iter()
                    .any(|stored| stored.0 == cand.locator)
                {
                    next_state
                        .pending_deselected_locators
                        .push(StoredLocator(cand.locator.clone()));
                }
            }
            self.persist_state(next_state.clone()).await?;
            self.state = next_state;
            self.pending_deselected_handles = next_pending_handles;
        } else {
            return Err(LibrarySyncError::InvalidWorkspace);
        }

        self.paused_until_trigger = false;
        self.backoff_step = 0;
        self.next_backoff_at = None;
        self.run_requested = true;
        self.publish(true);
        Ok(self.current_snapshot_for(workspace))
    }

    async fn handle_sync_now(
        &mut self,
        workspace: FileWorkspaceHandle,
    ) -> Result<LibrarySyncSnapshot, LibrarySyncError> {
        if self.state.mode == SyncMode::Off {
            return Err(LibrarySyncError::NotActive);
        }
        self.refresh_account_connected().await;
        self.paused_until_trigger = false;
        self.unsupported_server = false;
        self.backoff_step = 0;
        self.next_backoff_at = None;
        self.run_requested = true;
        self.publish(true);
        Ok(self.current_snapshot_for(workspace))
    }

    async fn periodic_scan_check(&mut self) {
        let Some(workspace) = self.state.workspace.clone() else {
            return;
        };
        match self.scan_workspace(&workspace).await {
            Ok(scan) => {
                let new_fp = scan.fingerprints();
                let changed = self.last_fingerprints.as_ref() != Some(&new_fp);
                // Re-run on an unchanged fingerprint when a complete scan sees an unmatched state
                // entry and no backoff is pending (so absence counting and deletion advance without
                // overriding exponential backoff, S-4/S-5/D5), or when recovering from a previous
                // FolderUnavailable periodic scan error.
                let needs_absence_run = scan.complete
                    && self.next_backoff_at.is_none()
                    && has_unmatched_entries(&scan.candidates, &self.state);
                let recovering_folder = self.overall_state == LibrarySyncState::FolderUnavailable;
                self.hash_cache = scan.updated_hash_cache;
                if changed || needs_absence_run || recovering_folder {
                    self.run_requested = true;
                } else {
                    self.next_scan_at = Some(Instant::now() + self.config.scan_interval);
                }
            }
            Err(crate::error::Error::Cancellation) => {}
            Err(_) => {
                self.overall_state = LibrarySyncState::FolderUnavailable;
                self.publish(true);
                self.next_scan_at = Some(Instant::now() + self.config.scan_interval);
            }
        }
    }

    async fn sleep_interruptible(
        &mut self,
        duration: Duration,
        receiver: &mut mpsc::Receiver<WorkerMessage>,
    ) -> bool {
        tokio::select! {
            biased;
            _ = self.cancel.cancelled() => true,
            msg = receiver.recv() => {
                if let Some(msg) = msg {
                    self.handle_message(msg).await;
                }
                true
            }
            _ = tokio::time::sleep(duration) => false,
        }
    }

    fn effective_retry_after(&self, server_duration: Duration) -> Duration {
        self.config
            .retry_after_cap
            .map_or(server_duration, |cap| server_duration.min(cap))
    }

    /// Shared retry loop for list, put and delete calls against the account worker.
    async fn run_with_retries<T, F, Fut>(
        &mut self,
        receiver: &mut mpsc::Receiver<WorkerMessage>,
        mut op: F,
    ) -> Result<T, RunOutcome>
    where
        F: FnMut(AccountOwner) -> Fut,
        Fut: Future<Output = Result<T, LibraryRequestError>>,
    {
        let Some(account) = self.account.get().cloned() else {
            self.overall_state = LibrarySyncState::Unavailable;
            self.publish(true);
            return Err(RunOutcome::StopUntilTrigger);
        };
        if !account.is_available() {
            self.overall_state = LibrarySyncState::Unavailable;
            self.publish(true);
            return Err(RunOutcome::StopUntilTrigger);
        }

        for attempt in 0..=MAX_TRANSIENT_RETRIES {
            let outcome = tokio::select! {
                biased;
                _ = self.cancel.cancelled() => return Err(RunOutcome::Interrupted),
                res = op(account.clone()) => res,
            };
            match outcome {
                Ok(value) => return Ok(value),
                Err(LibraryRequestError::Busy { retry_after })
                | Err(LibraryRequestError::RateLimited { retry_after }) => {
                    if attempt == MAX_TRANSIENT_RETRIES {
                        self.overall_state = LibrarySyncState::ServerBusy;
                        self.publish(true);
                        return Err(RunOutcome::ScheduleBackoff);
                    }
                    let wait = self.effective_retry_after(retry_after);
                    if self.sleep_interruptible(wait, receiver).await {
                        return Err(RunOutcome::Interrupted);
                    }
                }
                Err(LibraryRequestError::Unsupported) => {
                    self.unsupported_server = true;
                    self.overall_state = LibrarySyncState::Unavailable;
                    self.publish(true);
                    return Err(RunOutcome::StopUntilTrigger);
                }
                Err(LibraryRequestError::AccountChanged) => {
                    return Err(RunOutcome::ImmediateRerun);
                }
                Err(LibraryRequestError::Account(AccountError::Busy)) => {
                    if attempt == MAX_TRANSIENT_RETRIES {
                        self.overall_state = LibrarySyncState::ServerBusy;
                        self.publish(true);
                        return Err(RunOutcome::ScheduleBackoff);
                    }
                    if self
                        .sleep_interruptible(self.config.busy_retry_wait, receiver)
                        .await
                    {
                        return Err(RunOutcome::Interrupted);
                    }
                }
                Err(LibraryRequestError::Account(error)) => {
                    return Err(self.handle_account_error(error));
                }
            }
        }
        Err(RunOutcome::ScheduleBackoff)
    }

    async fn list_with_retries(
        &mut self,
        receiver: &mut mpsc::Receiver<WorkerMessage>,
    ) -> Result<(u64, StudioLibraryList), RunOutcome> {
        self.run_with_retries(
            receiver,
            |account| async move { account.library_list().await },
        )
        .await
    }

    async fn delete_with_retries(
        &mut self,
        epoch: u64,
        studio_file_id: String,
        receiver: &mut mpsc::Receiver<WorkerMessage>,
    ) -> Result<(), RunOutcome> {
        self.run_with_retries(receiver, move |account| {
            let id = studio_file_id.clone();
            async move { account.library_delete(epoch, id).await }
        })
        .await
    }

    fn handle_account_error(&mut self, error: AccountError) -> RunOutcome {
        match error {
            AccountError::Network => {
                self.overall_state = LibrarySyncState::Offline;
                self.publish(true);
                RunOutcome::ScheduleBackoff
            }
            AccountError::NotConnected
            | AccountError::InvalidGrant
            | AccountError::Authentication => {
                if matches!(error, AccountError::NotConnected) {
                    self.account_connected = false;
                }
                self.overall_state = LibrarySyncState::SignInNeeded;
                self.publish(true);
                RunOutcome::StopUntilTrigger
            }
            AccountError::Storage => {
                self.overall_state = LibrarySyncState::LocalError;
                self.publish(true);
                RunOutcome::StopUntilTrigger
            }
            AccountError::Unavailable => {
                self.overall_state = LibrarySyncState::Unavailable;
                self.publish(true);
                RunOutcome::StopUntilTrigger
            }
            _ => {
                self.overall_state = LibrarySyncState::ServerError;
                self.publish(true);
                RunOutcome::ScheduleBackoff
            }
        }
    }

    async fn execute_sync_run(
        &mut self,
        receiver: &mut mpsc::Receiver<WorkerMessage>,
    ) -> RunOutcome {
        let Some(workspace) = self.state.workspace.clone() else {
            self.overall_state = LibrarySyncState::FolderUnavailable;
            self.publish(true);
            return RunOutcome::ScheduleBackoff;
        };

        // 1. Scan workspace.
        let scan = match self.scan_workspace(&workspace).await {
            Ok(scan) => scan,
            Err(crate::error::Error::Cancellation) => return RunOutcome::Interrupted,
            Err(_) => {
                self.overall_state = LibrarySyncState::FolderUnavailable;
                self.publish(true);
                return RunOutcome::ScheduleBackoff;
            }
        };
        self.hash_cache = scan.updated_hash_cache.clone();
        self.last_fingerprints = Some(scan.fingerprints());

        // 2. List server files (binds account_id and connection epoch).
        let (mut epoch, mut list) = match self.list_with_retries(receiver).await {
            Ok(pair) => pair,
            Err(outcome) => return outcome,
        };
        if self.state.mode != SyncMode::On {
            return RunOutcome::Interrupted;
        }

        // Verify or bind server account_id.
        let mut working_state = self.state.clone();
        match working_state.account_id.as_deref() {
            None => {
                working_state.account_id = Some(list.account_id.clone());
                self.account_matches = true;
            }
            Some(stored) if stored == list.account_id => {
                self.account_matches = true;
            }
            Some(_) => {
                self.account_matches = false;
                self.overall_state = LibrarySyncState::Off;
                self.publish(true);
                return RunOutcome::StopUntilTrigger;
            }
        }

        // 3. Match candidates to entries (5-pass, including pass 4 adoption) and persist BEFORE
        // sending any write request.
        let can_increment_missed = scan.complete
            && self
                .last_complete_scan_at
                .is_none_or(|t| t.elapsed() >= self.config.scan_interval);
        let initial_deselected_locators: HashSet<Vec<OsString>> = working_state
            .pending_deselected_locators
            .iter()
            .map(|stored| stored.0.clone())
            .collect();
        let matched_ids = match_candidates_to_entries(
            &scan.candidates,
            &mut working_state,
            Some(&list.files),
            scan.complete,
            can_increment_missed,
            &self.pending_deselected_handles,
            &initial_deselected_locators,
        );
        // Drop a pending deselection only once its file was matched (its entry now carries
        // `selected: false`) or once a complete scan proved the file is gone.
        let mut next_pending_handles = self.pending_deselected_handles.clone();
        if scan.complete {
            working_state.pending_deselected_locators.clear();
            next_pending_handles.clear();
            self.last_complete_scan_at = Some(Instant::now());
        } else {
            let matched_handles: HashSet<&FileWorkspaceHandle> = scan
                .candidates
                .iter()
                .zip(matched_ids.iter())
                .filter_map(|(c, id)| id.as_ref().map(|_| &c.handle))
                .collect();
            let matched_locators: HashSet<&Vec<OsString>> = scan
                .candidates
                .iter()
                .zip(matched_ids.iter())
                .filter_map(|(c, id)| id.as_ref().map(|_| &c.locator))
                .collect();
            working_state
                .pending_deselected_locators
                .retain(|stored| !matched_locators.contains(&stored.0));
            next_pending_handles.retain(|handle| !matched_handles.contains(handle));
        }

        if self.persist_state(working_state.clone()).await.is_err() {
            return self.enter_local_error();
        }
        self.state = working_state;
        self.pending_deselected_handles = next_pending_handles;
        self.last_candidates = scan.candidates.clone();
        self.last_matched_ids = matched_ids.clone();

        // 4. Plan reconcile actions.
        let actions = plan_reconcile(
            &scan.candidates,
            &matched_ids,
            &self.state,
            &list.files,
            scan.complete,
            true,
        );

        let action_ids: HashSet<&str> = actions
            .iter()
            .map(|a| match a {
                SyncAction::Delete { studio_file_id } | SyncAction::Put { studio_file_id, .. } => {
                    studio_file_id.as_str()
                }
            })
            .collect();
        self.file_statuses.clear();
        for (candidate, maybe_id) in scan.candidates.iter().zip(matched_ids.iter()) {
            let Some(id) = maybe_id.as_ref() else {
                continue;
            };
            let Some(entry) = self.state.entries.get(id) else {
                continue;
            };
            let default_status = if action_ids.contains(id.as_str()) {
                LibrarySyncFileStatus::Pending
            } else {
                LibrarySyncFileStatus::Synced
            };
            let status =
                candidate_file_status(candidate, entry.selected, Some(entry), None, default_status);
            self.file_statuses.insert(id.clone(), status);
        }

        let total = actions.len().min(u32::MAX as usize) as u32;
        let mut done: u32 = 0;
        let mut pending_count: u32 = 0;
        let mut capacity_stop: Option<LibrarySyncFileStatus> = None;

        if total > 0 {
            self.overall_state = LibrarySyncState::Syncing { done: 0, total };
            self.publish(true);
        }

        // 5. Execute one request at a time.
        for action in actions {
            if self.cancel.is_cancelled() {
                return RunOutcome::Interrupted;
            }
            while let Ok(msg) = receiver.try_recv() {
                self.handle_message(msg).await;
                if self.cancel.is_cancelled()
                    || self.state.mode != SyncMode::On
                    || self.paused_until_trigger
                {
                    return RunOutcome::Interrupted;
                }
            }

            match action {
                SyncAction::Delete { studio_file_id } => {
                    match self
                        .delete_with_retries(epoch, studio_file_id.clone(), receiver)
                        .await
                    {
                        Ok(()) => {
                            done = done.saturating_add(1);
                            if self
                                .state
                                .entries
                                .get(&studio_file_id)
                                .is_some_and(|e| e.missed_scans >= ABSENCE_DELETE_THRESHOLD)
                            {
                                let mut next_state = self.state.clone();
                                next_state.entries.remove(&studio_file_id);
                                if self.persist_state(next_state.clone()).await.is_err() {
                                    return self.enter_local_error();
                                }
                                self.state = next_state;
                            }
                            self.overall_state = LibrarySyncState::Syncing { done, total };
                            self.publish(true);
                        }
                        Err(outcome) => return outcome,
                    }
                }
                SyncAction::Put {
                    studio_file_id,
                    handle,
                    name,
                    kind,
                    precondition,
                } => {
                    let is_create = matches!(precondition, LibraryPrecondition::Create);
                    if is_create {
                        if let Some(status) = capacity_stop.clone() {
                            self.file_statuses.insert(studio_file_id, status);
                            done = done.saturating_add(1);
                            self.overall_state = LibrarySyncState::Syncing { done, total };
                            self.publish(true);
                            continue;
                        }
                    }
                    self.file_statuses
                        .insert(studio_file_id.clone(), LibrarySyncFileStatus::Uploading);
                    self.publish(true);
                    let target = PutTarget {
                        studio_file_id: studio_file_id.clone(),
                        handle,
                        name,
                        kind,
                        precondition,
                    };
                    match self
                        .put_with_replan(&mut epoch, &mut list, target, receiver)
                        .await
                    {
                        PutStepOutcome::Done => {
                            self.file_statuses
                                .insert(studio_file_id, LibrarySyncFileStatus::Synced);
                            done = done.saturating_add(1);
                        }
                        PutStepOutcome::Pending => {
                            pending_count = pending_count.saturating_add(1);
                            self.file_statuses
                                .insert(studio_file_id, LibrarySyncFileStatus::Pending);
                        }
                        PutStepOutcome::FileStatus { status, capacity } => {
                            if is_create && capacity {
                                capacity_stop = Some(status.clone());
                            }
                            self.file_statuses.insert(studio_file_id, status);
                            done = done.saturating_add(1);
                        }
                        PutStepOutcome::AbortRun(outcome) => return outcome,
                    }
                    self.overall_state = LibrarySyncState::Syncing { done, total };
                    self.publish(true);
                }
            }
        }

        // Compute final overall state: never publish `Synced` while any file remains pending.
        let attention_count = self
            .build_files_view()
            .iter()
            .filter(|f| f.selected && f.status.is_attention())
            .count()
            .min(u32::MAX as usize) as u32;
        self.overall_state = if attention_count > 0 {
            LibrarySyncState::Attention {
                count: attention_count,
            }
        } else if pending_count > 0 {
            LibrarySyncState::Syncing { done, total }
        } else {
            LibrarySyncState::Synced
        };
        self.publish(true);

        if pending_count > 0 {
            RunOutcome::ScheduleBackoff
        } else {
            RunOutcome::Done
        }
    }

    async fn put_with_replan(
        &mut self,
        epoch: &mut u64,
        list: &mut StudioLibraryList,
        mut target: PutTarget,
        receiver: &mut mpsc::Receiver<WorkerMessage>,
    ) -> PutStepOutcome {
        let authority = self.authority.clone();
        let read_handle = target.handle.clone();
        let cancel = self.cancel.clone();
        let read_result = BLOCKING_GATEWAY
            .spawn_cancellable(cancel, move |token| {
                read_candidate_bytes_blocking(&authority, &read_handle, token)
            })
            .await;
        let (bytes, actual_sha) = match read_result {
            Ok(Some(pair)) => pair,
            Ok(None) => {
                return PutStepOutcome::FileStatus {
                    status: LibrarySyncFileStatus::TooLarge,
                    capacity: false,
                };
            }
            Err(crate::error::Error::Cancellation) => {
                return PutStepOutcome::AbortRun(RunOutcome::Interrupted);
            }
            Err(_) => {
                return PutStepOutcome::FileStatus {
                    status: LibrarySyncFileStatus::Unreadable,
                    capacity: false,
                };
            }
        };

        for replan_attempt in 0..=1u8 {
            let current_epoch = *epoch;
            let id = target.studio_file_id.clone();
            let name = target.name.clone();
            let kind = target.kind;
            let precondition = target.precondition;
            let payload = bytes.clone();
            let result = self
                .run_with_retries(receiver, move |account| {
                    let id = id.clone();
                    let name = name.clone();
                    let payload = payload.clone();
                    async move {
                        account
                            .library_put(current_epoch, id, name, kind, payload, precondition)
                            .await
                    }
                })
                .await;

            match result {
                Ok(LibraryPutResponse::Saved(saved)) => {
                    if let Some(existing) = list
                        .files
                        .iter_mut()
                        .find(|f| f.studio_file_id == saved.studio_file_id)
                    {
                        *existing = saved;
                    } else {
                        list.files.push(saved);
                    }
                    if self
                        .state
                        .entries
                        .get(&target.studio_file_id)
                        .is_some_and(|e| e.last_rejection.is_some())
                    {
                        let mut next_state = self.state.clone();
                        if let Some(entry) = next_state.entries.get_mut(&target.studio_file_id) {
                            entry.last_rejection = None;
                        }
                        if self.persist_state(next_state.clone()).await.is_err() {
                            return PutStepOutcome::AbortRun(self.enter_local_error());
                        }
                        self.state = next_state;
                    }
                    return PutStepOutcome::Done;
                }
                Ok(LibraryPutResponse::PreconditionFailed { .. }) => {
                    if replan_attempt == 1 {
                        return PutStepOutcome::Pending;
                    }
                    let (new_epoch, new_list) = match self.list_with_retries(receiver).await {
                        Ok(pair) => pair,
                        Err(outcome) => return PutStepOutcome::AbortRun(outcome),
                    };
                    if self.state.account_id.as_deref() != Some(new_list.account_id.as_str()) {
                        self.account_matches = false;
                        self.overall_state = LibrarySyncState::Off;
                        self.publish(true);
                        return PutStepOutcome::AbortRun(RunOutcome::StopUntilTrigger);
                    }
                    *epoch = new_epoch;
                    *list = new_list;
                    match list
                        .files
                        .iter()
                        .find(|f| f.studio_file_id == target.studio_file_id)
                    {
                        Some(sf) => {
                            if sf.content_sha256.as_deref() == Some(actual_sha.as_str())
                                && sf.name == target.name
                                && sf.kind == target.kind
                            {
                                return PutStepOutcome::Done;
                            }
                            target.precondition = LibraryPrecondition::Replace(sf.version);
                        }
                        None => {
                            target.precondition = LibraryPrecondition::Create;
                        }
                    }
                }
                Ok(LibraryPutResponse::Rejected { code, game_number }) => {
                    if code.is_file_intrinsic() {
                        let mut next_state = self.state.clone();
                        if let Some(entry) = next_state.entries.get_mut(&target.studio_file_id) {
                            entry.last_rejection = Some(FileRejection {
                                content_sha256: actual_sha.clone(),
                                code,
                                game_number,
                            });
                        }
                        if self.persist_state(next_state.clone()).await.is_err() {
                            return PutStepOutcome::AbortRun(self.enter_local_error());
                        }
                        self.state = next_state;
                    }
                    return PutStepOutcome::FileStatus {
                        status: code.to_file_status(game_number),
                        capacity: code.is_account_capacity(),
                    };
                }
                Err(outcome) => return PutStepOutcome::AbortRun(outcome),
            }
        }
        PutStepOutcome::Pending
    }

    async fn execute_removing_run(
        &mut self,
        receiver: &mut mpsc::Receiver<WorkerMessage>,
    ) -> RunOutcome {
        let (epoch, list) = match self.list_with_retries(receiver).await {
            Ok(pair) => pair,
            Err(outcome) => return outcome,
        };
        if self.state.mode != SyncMode::Removing {
            return RunOutcome::Interrupted;
        }
        if let Some(stored) = self.state.account_id.as_deref() {
            if stored != list.account_id {
                self.account_matches = false;
                self.overall_state = LibrarySyncState::Off;
                self.publish(true);
                return RunOutcome::StopUntilTrigger;
            }
        }
        self.account_matches = true;

        let server_ids: HashSet<&str> = list
            .files
            .iter()
            .map(|f| f.studio_file_id.as_str())
            .collect();
        let to_delete: Vec<String> = self
            .state
            .entries
            .keys()
            .filter(|id| server_ids.contains(id.as_str()))
            .cloned()
            .collect();
        let total = to_delete.len().min(u32::MAX as usize) as u32;
        let mut done: u32 = 0;

        self.overall_state = LibrarySyncState::Removing { done, total };
        self.publish(true);

        for id in to_delete {
            if self.cancel.is_cancelled() {
                return RunOutcome::Interrupted;
            }
            while let Ok(msg) = receiver.try_recv() {
                self.handle_message(msg).await;
                if self.cancel.is_cancelled()
                    || self.state.mode != SyncMode::Removing
                    || self.paused_until_trigger
                {
                    return RunOutcome::Interrupted;
                }
            }
            if let Err(outcome) = self.delete_with_retries(epoch, id.clone(), receiver).await {
                return outcome;
            }
            let mut next_state = self.state.clone();
            next_state.entries.remove(&id);
            if self.persist_state(next_state.clone()).await.is_err() {
                return self.enter_local_error();
            }
            self.state = next_state;
            done = done.saturating_add(1);
            self.overall_state = LibrarySyncState::Removing { done, total };
            self.publish(true);
        }

        let off = SyncState::off();
        if self.persist_state(off.clone()).await.is_err() {
            return self.enter_local_error();
        }
        self.state = off;
        self.pending_deselected_handles.clear();
        self.overall_state = LibrarySyncState::Off;
        self.file_statuses.clear();
        self.last_candidates.clear();
        self.last_matched_ids.clear();
        self.last_fingerprints = None;
        self.last_complete_scan_at = None;
        self.publish(true);
        RunOutcome::Done
    }
}

enum PutStepOutcome {
    Done,
    Pending,
    FileStatus {
        status: LibrarySyncFileStatus,
        capacity: bool,
    },
    AbortRun(RunOutcome),
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        credentials::{ChessRiddleCredentials, MemoryCredentialStore},
        infra::path_authority::{PathAuthority, PathClass, PathOperation, PathRef},
        library_sync::wire::{
            LibraryFileKind, StudioLibraryFile, StudioLibraryList, LIBRARY_LIST_MAX_RESPONSE_BYTES,
        },
    };
    use axum::{
        extract::{Path as AxumPath, State},
        http::{HeaderMap, StatusCode},
        response::{IntoResponse, Response},
        routing::{get, post, put},
        Json, Router,
    };
    use serde_json::json;
    use sha2::{Digest, Sha256};
    use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};

    #[derive(Clone, Debug)]
    struct RecordedPut {
        studio_file_id: String,
        if_none_match: Option<String>,
        if_match: Option<String>,
        body: Vec<u8>,
    }

    struct MockServerState {
        account_id: Mutex<String>,
        files: Mutex<HashMap<String, StudioLibraryFile>>,
        recorded_puts: Mutex<Vec<RecordedPut>>,
        deleted_ids: Mutex<Vec<String>>,
        list_count: AtomicU32,
        put_count: AtomicU32,
        delete_count: AtomicU32,
        fail_next_put_401: AtomicBool,
        fail_next_put_412_count: AtomicU32,
        fail_next_put_503_count: AtomicU32,
        fail_all_403_forbidden: AtomicBool,
        fail_all_500: AtomicBool,
        fail_delete_404: AtomicBool,
        fail_next_put_with_lost_answer: AtomicBool,
        reject_invalid_pgn_name: Mutex<Option<String>>,
        enforce_file_limit: AtomicU32,
        force_always_401: AtomicBool,
        list_oversized: AtomicBool,
        on_put_success: Mutex<Option<Box<dyn FnOnce() + Send>>>,
        on_delete_success: Mutex<Option<Box<dyn FnOnce() + Send>>>,
    }

    impl MockServerState {
        fn new(account_id: &str) -> Arc<Self> {
            Arc::new(Self {
                account_id: Mutex::new(account_id.to_owned()),
                files: Mutex::new(HashMap::new()),
                recorded_puts: Mutex::new(Vec::new()),
                deleted_ids: Mutex::new(Vec::new()),
                list_count: AtomicU32::new(0),
                put_count: AtomicU32::new(0),
                delete_count: AtomicU32::new(0),
                fail_next_put_401: AtomicBool::new(false),
                fail_next_put_412_count: AtomicU32::new(0),
                fail_next_put_503_count: AtomicU32::new(0),
                fail_all_403_forbidden: AtomicBool::new(false),
                fail_all_500: AtomicBool::new(false),
                fail_delete_404: AtomicBool::new(false),
                fail_next_put_with_lost_answer: AtomicBool::new(false),
                reject_invalid_pgn_name: Mutex::new(None),
                enforce_file_limit: AtomicU32::new(0),
                force_always_401: AtomicBool::new(false),
                list_oversized: AtomicBool::new(false),
                on_put_success: Mutex::new(None),
                on_delete_success: Mutex::new(None),
            })
        }
    }

    fn extract_multipart_part(body: &[u8], field_name: &str) -> Option<Vec<u8>> {
        let needle = format!("name=\"{field_name}\"");
        let start = body
            .windows(needle.len())
            .position(|window| window == needle.as_bytes())?;
        let after_name = &body[start + needle.len()..];
        let header_end = after_name
            .windows(4)
            .position(|window| window == b"\r\n\r\n")?;
        let content_start = &after_name[header_end + 4..];
        let end = content_start
            .windows(4)
            .position(|window| window == b"\r\n--")?;
        Some(content_start[..end].to_vec())
    }

    async fn mock_token() -> Response {
        (
            StatusCode::OK,
            Json(json!({
                "access_token": "tok-access",
                "refresh_token": "tok-refresh",
                "expires_in": 3600,
                "token_type": "Bearer"
            })),
        )
            .into_response()
    }

    async fn mock_revoke() -> StatusCode {
        StatusCode::NO_CONTENT
    }

    async fn mock_list(State(s): State<Arc<MockServerState>>) -> Response {
        s.list_count.fetch_add(1, Ordering::SeqCst);
        if s.force_always_401.load(Ordering::SeqCst) {
            return StatusCode::UNAUTHORIZED.into_response();
        }
        if s.fail_all_403_forbidden.load(Ordering::SeqCst) {
            return (
                StatusCode::FORBIDDEN,
                Json(json!({
                    "error": { "code": "FORBIDDEN", "details": { "reason": "desktop_route_forbidden" } }
                })),
            )
                .into_response();
        }
        if s.fail_all_500.load(Ordering::SeqCst) {
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
        if s.list_oversized.load(Ordering::SeqCst) {
            let big = "a".repeat(LIBRARY_LIST_MAX_RESPONSE_BYTES + 1024);
            return (StatusCode::OK, big).into_response();
        }
        let account_id = s.account_id.lock().unwrap().clone();
        let files: Vec<StudioLibraryFile> = s.files.lock().unwrap().values().cloned().collect();
        (
            StatusCode::OK,
            Json(StudioLibraryList { account_id, files }),
        )
            .into_response()
    }

    async fn mock_put(
        State(s): State<Arc<MockServerState>>,
        AxumPath(id): AxumPath<String>,
        headers: HeaderMap,
        body: axum::body::Bytes,
    ) -> Response {
        s.put_count.fetch_add(1, Ordering::SeqCst);
        s.recorded_puts.lock().unwrap().push(RecordedPut {
            studio_file_id: id.clone(),
            if_none_match: headers
                .get("if-none-match")
                .and_then(|v| v.to_str().ok())
                .map(str::to_owned),
            if_match: headers
                .get("if-match")
                .and_then(|v| v.to_str().ok())
                .map(str::to_owned),
            body: body.to_vec(),
        });
        if s.force_always_401.load(Ordering::SeqCst)
            || s.fail_next_put_401.swap(false, Ordering::SeqCst)
        {
            return StatusCode::UNAUTHORIZED.into_response();
        }
        if s.fail_all_403_forbidden.load(Ordering::SeqCst) {
            return (
                StatusCode::FORBIDDEN,
                Json(json!({
                    "error": { "code": "FORBIDDEN", "details": { "reason": "desktop_route_forbidden" } }
                })),
            )
                .into_response();
        }
        if s.fail_next_put_503_count
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |v| v.checked_sub(1))
            .is_ok()
        {
            let mut resp = (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({ "error": { "code": "LIBRARY_BUSY" } })),
            )
                .into_response();
            resp.headers_mut()
                .insert("retry-after", "1".parse().unwrap());
            return resp;
        }
        if s.fail_next_put_412_count
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |v| v.checked_sub(1))
            .is_ok()
        {
            let mut files = s.files.lock().unwrap();
            let next_v = files.get(&id).map_or(2, |f| f.version + 1);
            files.insert(
                id.clone(),
                StudioLibraryFile {
                    studio_file_id: id,
                    name: "Old".into(),
                    kind: LibraryFileKind::Games,
                    version: next_v,
                    content_sha256: Some("old-sha".into()),
                },
            );
            return (
                StatusCode::PRECONDITION_FAILED,
                Json(json!({
                    "error": {
                        "code": "PRECONDITION_FAILED",
                        "details": { "error_code": "version_mismatch", "version": next_v }
                    }
                })),
            )
                .into_response();
        }

        let name = extract_multipart_part(&body, "name")
            .and_then(|b| String::from_utf8(b).ok())
            .unwrap_or_else(|| "File".into());
        let kind_str = extract_multipart_part(&body, "kind")
            .and_then(|b| String::from_utf8(b).ok())
            .unwrap_or_else(|| "games".into());
        let kind = if kind_str == "repertoire" {
            LibraryFileKind::Repertoire
        } else {
            LibraryFileKind::Games
        };
        let file_bytes = extract_multipart_part(&body, "file").unwrap_or_default();
        let sha = format!("{:x}", Sha256::digest(&file_bytes));

        if s.reject_invalid_pgn_name
            .lock()
            .unwrap()
            .as_deref()
            .is_some_and(|bad| bad == name)
        {
            return (
                StatusCode::UNPROCESSABLE_ENTITY,
                Json(json!({
                    "error": {
                        "code": "VALIDATION_ERROR",
                        "details": { "error_code": "invalid_pgn", "game_number": 2 }
                    }
                })),
            )
                .into_response();
        }

        let mut files = s.files.lock().unwrap();
        let limit = s.enforce_file_limit.load(Ordering::SeqCst) as usize;
        if headers.contains_key("if-none-match") {
            if let Some(existing) = files.get(&id) {
                return (
                    StatusCode::PRECONDITION_FAILED,
                    Json(json!({
                        "error": {
                            "code": "PRECONDITION_FAILED",
                            "details": { "error_code": "version_mismatch", "version": existing.version }
                        }
                    })),
                )
                    .into_response();
            }
            if limit > 0 && files.len() >= limit {
                return (
                    StatusCode::UNPROCESSABLE_ENTITY,
                    Json(json!({
                        "error": {
                            "code": "VALIDATION_ERROR",
                            "details": { "error_code": "account_file_limit" }
                        }
                    })),
                )
                    .into_response();
            }
        }
        let next_version = files.get(&id).map_or(1, |f| f.version + 1);
        let file = StudioLibraryFile {
            studio_file_id: id.clone(),
            name,
            kind,
            version: next_version,
            content_sha256: Some(sha),
        };
        files.insert(id, file.clone());

        if s.fail_next_put_with_lost_answer
            .swap(false, Ordering::SeqCst)
        {
            // Simulate answer lost after server stored the file.
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
        if let Some(hook) = s.on_put_success.lock().unwrap().take() {
            hook();
        }
        let status = if next_version == 1 {
            StatusCode::CREATED
        } else {
            StatusCode::OK
        };
        (status, Json(file)).into_response()
    }

    async fn mock_delete(
        State(s): State<Arc<MockServerState>>,
        AxumPath(id): AxumPath<String>,
    ) -> Response {
        s.delete_count.fetch_add(1, Ordering::SeqCst);
        s.deleted_ids.lock().unwrap().push(id.clone());
        if s.fail_all_500.load(Ordering::SeqCst) {
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
        if s.fail_delete_404.load(Ordering::SeqCst) {
            return StatusCode::NOT_FOUND.into_response();
        }
        s.files.lock().unwrap().remove(&id);
        if let Some(hook) = s.on_delete_success.lock().unwrap().take() {
            hook();
        }
        StatusCode::NO_CONTENT.into_response()
    }

    async fn start_mock_server(state: Arc<MockServerState>) -> String {
        let app = Router::new()
            .route("/api/v1/desktop-auth/token", post(mock_token))
            .route("/api/v1/desktop-auth/revoke", post(mock_revoke))
            .route("/api/v1/library/studio-files", get(mock_list))
            .route(
                "/api/v1/library/studio-files/:id",
                put(mock_put).delete(mock_delete),
            )
            .with_state(state);
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::Server::from_tcp(listener)
                .unwrap()
                .serve(app.into_make_service())
                .await;
        });
        format!("http://127.0.0.1:{}", addr.port())
    }

    fn register_test_workspace(
        pa: &mut PathAuthority,
        dir: &std::path::Path,
    ) -> FileWorkspaceHandle {
        let temp = pa
            .grant_dialog_operations(
                dir,
                "Library",
                PathClass::BoundedDialogGrant,
                vec![PathOperation::ReadPgn, PathOperation::WritePgn],
                Duration::from_secs(60),
                1,
            )
            .expect("grant dialog");
        let committed = pa
            .promote_dialog(
                &temp,
                PathClass::PersistentCustomRoot,
                "Library",
                vec![PathOperation::ReadPgn, PathOperation::WritePgn],
            )
            .expect("promote dialog");
        FileWorkspaceHandle::new(committed.id)
    }

    fn fast_config() -> WorkerConfig {
        WorkerConfig {
            scan_interval: Duration::from_secs(60),
            backoff_base: Duration::from_millis(30),
            backoff_max: Duration::from_millis(120),
            busy_retry_wait: Duration::from_millis(10),
            event_min_interval: Duration::from_millis(1),
            retry_after_cap: Some(Duration::from_millis(10)),
        }
    }

    struct TestHarness {
        _temp: tempfile::TempDir,
        workspace_dir: std::path::PathBuf,
        state_dir: Arc<AuthorizedDir>,
        authority: SharedPathAuthority,
        workspace: FileWorkspaceHandle,
        other_workspace: FileWorkspaceHandle,
        account: Arc<std::sync::OnceLock<AccountOwner>>,
        owner: LibrarySyncOwner,
        events: Arc<Mutex<Vec<u32>>>,
    }

    const ALPHA_PGN: &[u8] =
        b"[Event \"T\"]\n[White \"A\"]\n[Black \"B\"]\n[Result \"*\"]\n\n1. e4 e5 *\n";
    const BETA_PGN: &[u8] =
        b"[Event \"B\"]\n[White \"C\"]\n[Black \"D\"]\n[Result \"*\"]\n\n1. d4 d5 *\n";

    async fn build_harness_with_config(
        origin: &str,
        initial_state: SyncState,
        connected: bool,
        files: &[(&str, &[u8])],
        config: WorkerConfig,
    ) -> TestHarness {
        let temp = tempfile::tempdir().unwrap();
        let app_data = AppDataDir::for_test(temp.path());
        let state_dir = Arc::new(
            ensure_app_owned_default_dir(&app_data, AppOwnedDefaultRoot::LibrarySync).unwrap(),
        );
        let workspace_dir = temp.path().join("library");
        let other_dir = temp.path().join("other-library");
        std::fs::create_dir_all(&workspace_dir).unwrap();
        std::fs::create_dir_all(&other_dir).unwrap();
        for (name, bytes) in files {
            std::fs::write(workspace_dir.join(name), bytes).unwrap();
        }

        let authority = SharedPathAuthority::uninitialized();
        let mut pa = PathAuthority::open(temp.path().join("path-authority.json"), vec![]).unwrap();
        let workspace = register_test_workspace(&mut pa, &workspace_dir);
        let other_workspace = register_test_workspace(&mut pa, &other_dir);
        authority.install(pa).unwrap();

        let creds = Arc::new(ChessRiddleCredentials::with_store(Arc::new(
            MemoryCredentialStore::default(),
        )));
        creds.initialize(&app_data).unwrap();
        if connected {
            creds
                .store("ChessRiddle".into(), "tok-refresh".into())
                .await
                .unwrap();
        }
        let http = reqwest::Client::builder().no_proxy().build().unwrap();
        let account_owner = AccountOwner::start_for_test(creds, origin, http);
        let account_lock = Arc::new(std::sync::OnceLock::new());
        let _ = account_lock.set(account_owner);

        let events = Arc::new(Mutex::new(Vec::new()));
        let events_clone = Arc::clone(&events);
        let emit: EventEmitter = Arc::new(move |ev| {
            events_clone.lock().unwrap().push(ev.revision);
        });

        let owner = LibrarySyncOwner::start(
            Arc::clone(&state_dir),
            initial_state,
            authority.clone(),
            Arc::new(Mutex::new(())),
            Arc::clone(&account_lock),
            emit,
            config,
        );

        TestHarness {
            _temp: temp,
            workspace_dir,
            state_dir,
            authority,
            workspace,
            other_workspace,
            account: account_lock,
            owner,
            events,
        }
    }

    async fn build_harness(origin: &str, initial_state: SyncState, connected: bool) -> TestHarness {
        build_harness_with_config(
            origin,
            initial_state,
            connected,
            &[("Alpha.pgn", ALPHA_PGN)],
            fast_config(),
        )
        .await
    }

    async fn wait_for_state(
        owner: &LibrarySyncOwner,
        workspace: &FileWorkspaceHandle,
        predicate: impl Fn(&LibrarySyncSnapshot) -> bool,
    ) -> LibrarySyncSnapshot {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let snap = owner.snapshot(workspace.clone()).await.unwrap();
            if predicate(&snap) {
                return snap;
            }
            assert!(
                Instant::now() < deadline,
                "timed out waiting for state; last snapshot: {:?}",
                snap.state
            );
            tokio::time::sleep(Duration::from_millis(15)).await;
        }
    }

    #[tokio::test]
    async fn turn_on_rebuilds_multipart_after_401_and_handles_503_and_412_replan_and_followup() {
        let server = MockServerState::new("acct-1");
        server.fail_next_put_401.store(true, Ordering::SeqCst);
        server.fail_next_put_503_count.store(1, Ordering::SeqCst);
        // Two 412s in the first run leave the file pending; the follow-up run (without disk
        // changes) then sends If-Match with the listed version and succeeds.
        server.fail_next_put_412_count.store(2, Ordering::SeqCst);
        let origin = start_mock_server(Arc::clone(&server)).await;

        let mut cfg = fast_config();
        // Keep the follow-up backoff long enough to deterministically observe the pending state
        // between the second 412 and the follow-up run.
        cfg.backoff_base = Duration::from_millis(250);
        cfg.backoff_max = Duration::from_millis(500);
        let harness = build_harness_with_config(
            &origin,
            SyncState::off(),
            true,
            &[("Alpha.pgn", ALPHA_PGN)],
            cfg,
        )
        .await;
        harness
            .owner
            .turn_on(harness.workspace.clone(), vec![])
            .await
            .unwrap();

        // Between the second 412 (PUT #4) and the follow-up run (PUT #5), the file is pending
        // and the overall state must NOT be Synced.
        let pending_snap = wait_for_state(&harness.owner, &harness.workspace, |s| {
            server.put_count.load(Ordering::SeqCst) == 4
                && s.files
                    .first()
                    .is_some_and(|f| f.status == LibrarySyncFileStatus::Pending)
        })
        .await;
        assert_ne!(
            pending_snap.state,
            LibrarySyncState::Synced,
            "overall state must not report Synced while a file is still pending"
        );
        assert!(matches!(
            pending_snap.state,
            LibrarySyncState::Syncing { done: 0, total: 1 }
        ));

        let snap = wait_for_state(&harness.owner, &harness.workspace, |s| {
            s.state == LibrarySyncState::Synced
        })
        .await;
        assert_eq!(snap.files.len(), 1);
        assert_eq!(snap.files[0].status, LibrarySyncFileStatus::Synced);

        let puts = server.recorded_puts.lock().unwrap().clone();
        // 1: 401 (If-None-Match: *), 2: 503 (rebuilt body), 3: 412 #1, 4: 412 #2 (If-Match: "2"),
        // 5: follow-up run (If-Match: "3") -> 200.
        assert_eq!(puts.len(), 5, "recorded puts: {puts:?}");
        for put in &puts {
            assert_eq!(put.studio_file_id, puts[0].studio_file_id);
            let file_part = extract_multipart_part(&put.body, "file").expect("multipart file part");
            assert_eq!(file_part, ALPHA_PGN, "multipart body must match file bytes");
        }
        assert_eq!(puts[0].if_none_match.as_deref(), Some("*"));
        assert_eq!(puts[1].if_none_match.as_deref(), Some("*"));
        assert_eq!(puts[3].if_match.as_deref(), Some("\"2\""));
        assert_eq!(puts[4].if_match.as_deref(), Some("\"3\""));
        assert!(!harness.events.lock().unwrap().is_empty());

        harness.owner.shutdown().await;
    }

    #[tokio::test]
    async fn turn_on_adopts_matching_server_file_and_never_uploads_deselected_file() {
        let server = MockServerState::new("acct-1");
        let existing_id = "22222222-2222-4222-8222-222222222222";
        let alpha_sha = format!("{:x}", Sha256::digest(ALPHA_PGN));
        server.files.lock().unwrap().insert(
            existing_id.into(),
            StudioLibraryFile {
                studio_file_id: existing_id.into(),
                name: "Alpha".into(),
                kind: LibraryFileKind::Games,
                version: 1,
                content_sha256: Some(alpha_sha),
            },
        );
        let origin = start_mock_server(Arc::clone(&server)).await;

        let harness = build_harness_with_config(
            &origin,
            SyncState::off(),
            true,
            &[
                ("Alpha.pgn", ALPHA_PGN),
                ("Skip.pgn", b"[Event \"S\"]\n\n1. d4 d5 *\n"),
            ],
            fast_config(),
        )
        .await;

        let off_snap = harness
            .owner
            .snapshot(harness.workspace.clone())
            .await
            .unwrap();
        let skip_handle = off_snap
            .files
            .iter()
            .find(|f| f.name == "Skip")
            .unwrap()
            .handle
            .clone();

        harness
            .owner
            .turn_on(harness.workspace.clone(), vec![skip_handle])
            .await
            .unwrap();

        let snap = wait_for_state(&harness.owner, &harness.workspace, |s| {
            s.state == LibrarySyncState::Synced
        })
        .await;
        // Alpha was adopted (0 PUTs), Skip was deselected at turn-on (0 PUTs).
        assert_eq!(server.put_count.load(Ordering::SeqCst), 0);
        let persisted = SyncState::load(&harness.state_dir);
        assert!(persisted.entries.contains_key(existing_id));
        let skip_file = snap.files.iter().find(|f| f.name == "Skip").unwrap();
        assert!(!skip_file.selected);
        assert_eq!(skip_file.status, LibrarySyncFileStatus::NotSelected);

        harness.owner.shutdown().await;
    }

    #[tokio::test]
    async fn periodic_scan_uploads_edited_file_and_deletes_removed_file_after_two_complete_scans() {
        let server = MockServerState::new("acct-1");
        let origin = start_mock_server(Arc::clone(&server)).await;

        let mut cfg = fast_config();
        cfg.scan_interval = Duration::from_millis(40);
        let harness = build_harness_with_config(
            &origin,
            SyncState::off(),
            true,
            &[("Alpha.pgn", ALPHA_PGN)],
            cfg,
        )
        .await;

        harness
            .owner
            .turn_on(harness.workspace.clone(), vec![])
            .await
            .unwrap();
        wait_for_state(&harness.owner, &harness.workspace, |s| {
            s.state == LibrarySyncState::Synced
        })
        .await;
        assert_eq!(server.put_count.load(Ordering::SeqCst), 1);

        // Edit file on disk: periodic scan detects revision change and replaces it.
        std::fs::write(
            harness.workspace_dir.join("Alpha.pgn"),
            b"[Event \"T\"]\n\n1. e4 c5 *\n",
        )
        .unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while server.put_count.load(Ordering::SeqCst) < 2 {
            assert!(
                Instant::now() < deadline,
                "periodic scan did not upload edit"
            );
            tokio::time::sleep(Duration::from_millis(15)).await;
        }

        // Remove file from disk: two consecutive complete scans (at least one interval apart)
        // must trigger exactly one DELETE even though the fingerprint stops changing after miss 1.
        std::fs::remove_file(harness.workspace_dir.join("Alpha.pgn")).unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while server.delete_count.load(Ordering::SeqCst) < 1 {
            assert!(
                Instant::now() < deadline,
                "removed file was not deleted after two periodic scans"
            );
            tokio::time::sleep(Duration::from_millis(15)).await;
        }
        assert_eq!(server.delete_count.load(Ordering::SeqCst), 1);
        assert_eq!(server.deleted_ids.lock().unwrap().len(), 1);
        assert!(server.files.lock().unwrap().is_empty());

        harness.owner.shutdown().await;
    }

    #[tokio::test]
    async fn rejection_422_and_account_file_limit_behave_per_spec() {
        let server = MockServerState::new("acct-1");
        server.enforce_file_limit.store(1, Ordering::SeqCst);
        let origin = start_mock_server(Arc::clone(&server)).await;

        let harness = build_harness_with_config(
            &origin,
            SyncState::off(),
            true,
            &[
                ("A_First.pgn", b"1. e4 e5 *\n"),
                ("B_Bad.pgn", b"1. d4 d5 *\n"),
                ("C_Full1.pgn", b"1. c4 c5 *\n"),
                ("D_Full2.pgn", b"1. Nf3 Nf6 *\n"),
            ],
            fast_config(),
        )
        .await;
        *server.reject_invalid_pgn_name.lock().unwrap() = Some("B_Bad".into());

        harness
            .owner
            .turn_on(harness.workspace.clone(), vec![])
            .await
            .unwrap();

        let snap = wait_for_state(&harness.owner, &harness.workspace, |s| {
            matches!(s.state, LibrarySyncState::Attention { count: 3 })
        })
        .await;
        // C_Full1 hit account_file_limit -> D_Full2 was NOT attempted in the same run (only 3 PUTs).
        assert_eq!(server.put_count.load(Ordering::SeqCst), 3);
        let status_of = |name: &str| {
            snap.files
                .iter()
                .find(|f| f.name == name)
                .unwrap()
                .status
                .clone()
        };
        assert_eq!(status_of("A_First"), LibrarySyncFileStatus::Synced);
        assert_eq!(
            status_of("B_Bad"),
            LibrarySyncFileStatus::InvalidPgn {
                game_number: Some(2)
            }
        );
        assert_eq!(status_of("C_Full1"), LibrarySyncFileStatus::LibraryFull);
        assert_eq!(status_of("D_Full2"), LibrarySyncFileStatus::LibraryFull);

        // Free space on server and run again: C_Full1 and D_Full2 are retried (not memoised),
        // while B_Bad stays memoised and is not re-uploaded.
        server.enforce_file_limit.store(10, Ordering::SeqCst);
        let puts_before = server.put_count.load(Ordering::SeqCst);
        harness
            .owner
            .sync_now(harness.workspace.clone())
            .await
            .unwrap();
        let snap2 = wait_for_state(&harness.owner, &harness.workspace, |s| {
            matches!(s.state, LibrarySyncState::Attention { count: 1 })
        })
        .await;
        assert_eq!(server.put_count.load(Ordering::SeqCst) - puts_before, 2);
        assert_eq!(
            snap2
                .files
                .iter()
                .find(|f| f.name == "C_Full1")
                .unwrap()
                .status,
            LibrarySyncFileStatus::Synced
        );
        assert_eq!(
            snap2
                .files
                .iter()
                .find(|f| f.name == "D_Full2")
                .unwrap()
                .status,
            LibrarySyncFileStatus::Synced
        );

        harness.owner.shutdown().await;
    }

    #[tokio::test]
    async fn set_file_selected_deletes_at_once_and_reselect_uploads_again_and_lost_create_deletes()
    {
        let server = MockServerState::new("acct-1");
        server
            .fail_next_put_with_lost_answer
            .store(true, Ordering::SeqCst);
        let origin = start_mock_server(Arc::clone(&server)).await;

        let harness = build_harness(&origin, SyncState::off(), true).await;
        harness
            .owner
            .turn_on(harness.workspace.clone(), vec![])
            .await
            .unwrap();

        // First create answer was lost (500), even though the server stored the file.
        let err_snap = wait_for_state(&harness.owner, &harness.workspace, |s| {
            s.state == LibrarySyncState::ServerError
        })
        .await;
        assert_eq!(server.files.lock().unwrap().len(), 1);
        let file_handle = err_snap.files[0].handle.clone();

        // Deselecting immediately deletes the server file because the entry was persisted before PUT.
        harness
            .owner
            .set_file_selected(harness.workspace.clone(), file_handle.clone(), false)
            .await
            .unwrap();
        wait_for_state(&harness.owner, &harness.workspace, |s| {
            s.state == LibrarySyncState::Synced
                && s.files[0].status == LibrarySyncFileStatus::NotSelected
        })
        .await;
        assert!(server.files.lock().unwrap().is_empty());

        // Reselecting uploads it again.
        harness
            .owner
            .set_file_selected(harness.workspace.clone(), file_handle, true)
            .await
            .unwrap();
        wait_for_state(&harness.owner, &harness.workspace, |s| {
            s.state == LibrarySyncState::Synced
                && s.files[0].status == LibrarySyncFileStatus::Synced
        })
        .await;
        assert_eq!(server.files.lock().unwrap().len(), 1);

        harness.owner.shutdown().await;
    }

    #[tokio::test]
    async fn turn_off_keep_returns_candidate_files_and_other_folder_and_removing_semantics() {
        let server = MockServerState::new("acct-1");
        let origin = start_mock_server(Arc::clone(&server)).await;
        let harness = build_harness(&origin, SyncState::off(), true).await;

        harness
            .owner
            .turn_on(harness.workspace.clone(), vec![])
            .await
            .unwrap();
        wait_for_state(&harness.owner, &harness.workspace, |s| {
            s.state == LibrarySyncState::Synced
        })
        .await;

        // Another workspace sees OtherFolder while mode is On.
        let other_snap = harness
            .owner
            .snapshot(harness.other_workspace.clone())
            .await
            .unwrap();
        assert_eq!(other_snap.state, LibrarySyncState::OtherFolder);

        // Turn off with Keep returns the candidate files immediately.
        let keep_snap = harness
            .owner
            .turn_off(harness.workspace.clone(), LibrarySyncTurnOffMode::Keep)
            .await
            .unwrap();
        assert_eq!(keep_snap.state, LibrarySyncState::Off);
        assert_eq!(keep_snap.files.len(), 1);
        assert_eq!(keep_snap.files[0].name, "Alpha");

        // Turn back on, then turn off with Remove from another workspace -> Removing is reported
        // for every workspace, pauses on error, survives restart, and finishes.
        harness
            .owner
            .turn_on(harness.workspace.clone(), vec![])
            .await
            .unwrap();
        wait_for_state(&harness.owner, &harness.workspace, |s| {
            s.state == LibrarySyncState::Synced
        })
        .await;

        server.fail_all_500.store(true, Ordering::SeqCst);
        let rem_snap = harness
            .owner
            .turn_off(
                harness.other_workspace.clone(),
                LibrarySyncTurnOffMode::Remove,
            )
            .await
            .unwrap();
        assert!(matches!(rem_snap.state, LibrarySyncState::Removing { .. }));

        wait_for_state(&harness.owner, &harness.other_workspace, |s| {
            s.state == LibrarySyncState::ServerError
        })
        .await;

        // Simulate restart: shut down worker, reload persisted Removing state into a fresh worker,
        // restore server, and verify removal completes.
        harness.owner.shutdown().await;
        let persisted = SyncState::load(&harness.state_dir);
        assert_eq!(persisted.mode, SyncMode::Removing);
        server.fail_all_500.store(false, Ordering::SeqCst);

        let restarted = LibrarySyncOwner::start(
            Arc::clone(&harness.state_dir),
            persisted,
            harness.authority.clone(),
            Arc::new(Mutex::new(())),
            Arc::clone(&harness.account),
            Arc::new(|_| {}),
            fast_config(),
        );
        wait_for_state(&restarted, &harness.other_workspace, |s| {
            s.state == LibrarySyncState::Off
        })
        .await;
        assert!(server.files.lock().unwrap().is_empty());
        assert_eq!(SyncState::load(&harness.state_dir).mode, SyncMode::Off);
        restarted.shutdown().await;
    }

    #[tokio::test]
    async fn delete_404_is_success_and_remove_mode_clears_state() {
        let server = MockServerState::new("acct-1");
        server.fail_delete_404.store(true, Ordering::SeqCst);
        let origin = start_mock_server(Arc::clone(&server)).await;

        let harness = build_harness(&origin, SyncState::off(), true).await;
        harness
            .owner
            .turn_on(harness.workspace.clone(), vec![])
            .await
            .unwrap();
        wait_for_state(&harness.owner, &harness.workspace, |s| {
            s.state == LibrarySyncState::Synced
        })
        .await;

        harness
            .owner
            .turn_off(harness.workspace.clone(), LibrarySyncTurnOffMode::Remove)
            .await
            .unwrap();
        let snap = wait_for_state(&harness.owner, &harness.workspace, |s| {
            s.state == LibrarySyncState::Off
        })
        .await;
        assert_eq!(snap.state, LibrarySyncState::Off);
        assert!(server.delete_count.load(Ordering::SeqCst) >= 1);
        assert_eq!(SyncState::load(&harness.state_dir).mode, SyncMode::Off);

        harness.owner.shutdown().await;
    }

    #[tokio::test]
    async fn unsupported_server_and_second_401_and_list_bound_and_other_account() {
        let server = MockServerState::new("acct-1");
        server.fail_all_403_forbidden.store(true, Ordering::SeqCst);
        let origin = start_mock_server(Arc::clone(&server)).await;
        let harness = build_harness(&origin, SyncState::off(), true).await;
        harness
            .owner
            .turn_on(harness.workspace.clone(), vec![])
            .await
            .unwrap();
        wait_for_state(&harness.owner, &harness.workspace, |s| {
            s.state == LibrarySyncState::Unavailable
        })
        .await;

        server.fail_all_403_forbidden.store(false, Ordering::SeqCst);
        server.force_always_401.store(true, Ordering::SeqCst);
        harness
            .owner
            .sync_now(harness.workspace.clone())
            .await
            .unwrap();
        wait_for_state(&harness.owner, &harness.workspace, |s| {
            s.state == LibrarySyncState::SignInNeeded
        })
        .await;

        // Connect notification resumes a SignInNeeded worker.
        server.force_always_401.store(false, Ordering::SeqCst);
        server.list_oversized.store(true, Ordering::SeqCst);
        harness.owner.notify_account_connected();
        wait_for_state(&harness.owner, &harness.workspace, |s| {
            s.state == LibrarySyncState::ServerError
        })
        .await;

        // Normal sync binds acct-1, then another account sees Off and uploads nothing.
        server.list_oversized.store(false, Ordering::SeqCst);
        harness
            .owner
            .sync_now(harness.workspace.clone())
            .await
            .unwrap();
        wait_for_state(&harness.owner, &harness.workspace, |s| {
            s.state == LibrarySyncState::Synced
        })
        .await;

        let puts_before = server.put_count.load(Ordering::SeqCst);
        *server.account_id.lock().unwrap() = "acct-2".into();
        harness
            .owner
            .sync_now(harness.workspace.clone())
            .await
            .unwrap();
        wait_for_state(&harness.owner, &harness.workspace, |s| {
            s.state == LibrarySyncState::Off
        })
        .await;
        assert_eq!(server.put_count.load(Ordering::SeqCst), puts_before);

        harness.owner.shutdown().await;
    }

    #[tokio::test]
    async fn disconnect_during_retry_wait_stays_paused_as_sign_in_needed() {
        let server = MockServerState::new("acct-1");
        server.fail_next_put_503_count.store(1, Ordering::SeqCst);
        let origin = start_mock_server(Arc::clone(&server)).await;

        let mut cfg = fast_config();
        cfg.scan_interval = Duration::from_millis(30);
        cfg.retry_after_cap = Some(Duration::from_secs(10));
        let harness = build_harness_with_config(
            &origin,
            SyncState::off(),
            true,
            &[("Alpha.pgn", ALPHA_PGN)],
            cfg,
        )
        .await;
        harness
            .owner
            .turn_on(harness.workspace.clone(), vec![])
            .await
            .unwrap();

        // Wait until the first PUT (503) has entered the retry wait.
        let deadline = Instant::now() + Duration::from_secs(5);
        while server.put_count.load(Ordering::SeqCst) < 1 {
            assert!(Instant::now() < deadline);
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let lists_at_disconnect = server.list_count.load(Ordering::SeqCst);
        harness
            .account
            .get()
            .unwrap()
            .disconnect_for_test()
            .await
            .unwrap();
        harness.owner.notify_account_disconnected();

        let disconnected_snap = wait_for_state(&harness.owner, &harness.workspace, |s| {
            s.state == LibrarySyncState::SignInNeeded
        })
        .await;
        let rev_at_disconnect = disconnected_snap.revision;

        // Edit the file on disk and wait more than two scan intervals: if the disconnect did not
        // stay paused, the periodic scan would observe the changed fingerprint and start a run.
        std::fs::write(
            harness.workspace_dir.join("Alpha.pgn"),
            b"[Event \"Edited\"]\n\n1. d4 d5 *\n",
        )
        .unwrap();
        tokio::time::sleep(Duration::from_millis(120)).await;
        let after_snap = harness
            .owner
            .snapshot(harness.workspace.clone())
            .await
            .unwrap();
        assert_eq!(after_snap.state, LibrarySyncState::SignInNeeded);
        assert_eq!(after_snap.revision, rev_at_disconnect);
        assert_eq!(
            server.list_count.load(Ordering::SeqCst),
            lists_at_disconnect
        );

        harness.owner.shutdown().await;
    }

    #[tokio::test]
    async fn off_state_unavailable_folder_reports_folder_unavailable() {
        let server = MockServerState::new("acct-1");
        let origin = start_mock_server(Arc::clone(&server)).await;
        let harness = build_harness(&origin, SyncState::off(), true).await;

        let invalid = FileWorkspaceHandle::new(PathRef {
            id: "nonexistent-workspace".to_owned(),
        });
        let snap = harness.owner.snapshot(invalid).await.unwrap();
        assert_eq!(snap.state, LibrarySyncState::FolderUnavailable);
        assert!(snap.files.is_empty());

        harness.owner.shutdown().await;
    }

    #[tokio::test]
    async fn stale_epoch_and_non_uuid_ids_are_refused_before_http() {
        let server = MockServerState::new("acct-1");
        let origin = start_mock_server(Arc::clone(&server)).await;
        let harness = build_harness(&origin, SyncState::off(), true).await;
        let account = harness.account.get().unwrap();
        let (epoch, _) = account.library_list().await.expect("expected listed");

        // Non-UUID studio_file_id is refused before HTTP for both PUT and DELETE.
        let puts_before = server.put_count.load(Ordering::SeqCst);
        let deletes_before = server.delete_count.load(Ordering::SeqCst);
        assert_eq!(
            account
                .library_put(
                    epoch,
                    "../evil".into(),
                    "Alpha".into(),
                    LibraryFileKind::Games,
                    b"1. e4 *".to_vec(),
                    LibraryPrecondition::Create,
                )
                .await,
            Err(LibraryRequestError::Account(AccountError::InvalidRequest))
        );
        assert_eq!(
            account.library_delete(epoch, "../evil".into()).await,
            Err(LibraryRequestError::Account(AccountError::InvalidRequest))
        );
        assert_eq!(server.put_count.load(Ordering::SeqCst), puts_before);
        assert_eq!(server.delete_count.load(Ordering::SeqCst), deletes_before);

        // Stale epoch refused before HTTP for both PUT and DELETE.
        account.disconnect_for_test().await.unwrap();
        let valid_id = "11111111-1111-4111-8111-111111111111";
        assert_eq!(
            account
                .library_put(
                    epoch,
                    valid_id.into(),
                    "Alpha".into(),
                    LibraryFileKind::Games,
                    b"1. e4 *".to_vec(),
                    LibraryPrecondition::Create,
                )
                .await,
            Err(LibraryRequestError::AccountChanged)
        );
        assert_eq!(
            account.library_delete(epoch, valid_id.into()).await,
            Err(LibraryRequestError::AccountChanged)
        );
        assert_eq!(server.put_count.load(Ordering::SeqCst), puts_before);
        assert_eq!(server.delete_count.load(Ordering::SeqCst), deletes_before);

        harness.owner.shutdown().await;
    }

    #[tokio::test]
    async fn offline_backoff_retries_immediately_on_sync_now_and_shutdown_cancels_wait() {
        let server = MockServerState::new("acct-1");
        server.fail_all_500.store(true, Ordering::SeqCst);
        let origin = start_mock_server(Arc::clone(&server)).await;

        let harness = build_harness_with_config(
            &origin,
            SyncState::off(),
            true,
            &[("Alpha.pgn", ALPHA_PGN)],
            WorkerConfig {
                scan_interval: Duration::from_secs(300),
                backoff_base: Duration::from_secs(300),
                backoff_max: Duration::from_secs(300),
                ..fast_config()
            },
        )
        .await;

        harness
            .owner
            .turn_on(harness.workspace.clone(), vec![])
            .await
            .unwrap();
        wait_for_state(&harness.owner, &harness.workspace, |s| {
            s.state == LibrarySyncState::ServerError
        })
        .await;

        // Immediate retry on trigger even while inside a 300s backoff.
        server.fail_all_500.store(false, Ordering::SeqCst);
        harness
            .owner
            .sync_now(harness.workspace.clone())
            .await
            .unwrap();
        wait_for_state(&harness.owner, &harness.workspace, |s| {
            s.state == LibrarySyncState::Synced
        })
        .await;

        // Trigger another 300s backoff and verify shutdown cancels immediately.
        server.fail_all_500.store(true, Ordering::SeqCst);
        harness
            .owner
            .sync_now(harness.workspace.clone())
            .await
            .unwrap();
        wait_for_state(&harness.owner, &harness.workspace, |s| {
            s.state == LibrarySyncState::ServerError
        })
        .await;

        let started = Instant::now();
        harness.owner.shutdown().await;
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[tokio::test]
    async fn removed_file_during_same_interval_sync_now_is_deleted_by_later_periodic_scans() {
        let server = MockServerState::new("acct-1");
        let origin = start_mock_server(Arc::clone(&server)).await;

        let mut cfg = fast_config();
        cfg.scan_interval = Duration::from_millis(120);
        let harness = build_harness_with_config(
            &origin,
            SyncState::off(),
            true,
            &[("Alpha.pgn", ALPHA_PGN)],
            cfg,
        )
        .await;

        harness
            .owner
            .turn_on(harness.workspace.clone(), vec![])
            .await
            .unwrap();
        wait_for_state(&harness.owner, &harness.workspace, |s| {
            s.state == LibrarySyncState::Synced
        })
        .await;
        assert_eq!(server.put_count.load(Ordering::SeqCst), 1);

        // Remove the file immediately (well within one scan_interval of the last complete scan)
        // and trigger `sync_now`. That run stores the new empty fingerprint without incrementing
        // `missed_scans` yet; later periodic scans must still run and delete the server file.
        std::fs::remove_file(harness.workspace_dir.join("Alpha.pgn")).unwrap();
        let lists_before = server.list_count.load(Ordering::SeqCst);
        harness
            .owner
            .sync_now(harness.workspace.clone())
            .await
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while server.list_count.load(Ordering::SeqCst) <= lists_before {
            assert!(Instant::now() < deadline);
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert_eq!(server.delete_count.load(Ordering::SeqCst), 0);

        // Without any further disk change, subsequent periodic scans count both misses and delete it.
        let deadline = Instant::now() + Duration::from_secs(5);
        while server.delete_count.load(Ordering::SeqCst) < 1 {
            assert!(
                Instant::now() < deadline,
                "removed file whose first absence happened during an intra-interval run was never deleted"
            );
            tokio::time::sleep(Duration::from_millis(15)).await;
        }
        assert_eq!(server.delete_count.load(Ordering::SeqCst), 1);
        assert!(server.files.lock().unwrap().is_empty());

        harness.owner.shutdown().await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn entry_at_threshold_waits_through_incomplete_scans_then_deletes_when_complete() {
        use std::os::unix::fs::PermissionsExt;

        let server = MockServerState::new("acct-1");
        let missing_id = "44444444-4444-4444-8444-444444444444";
        server.files.lock().unwrap().insert(
            missing_id.into(),
            StudioLibraryFile {
                studio_file_id: missing_id.into(),
                name: "Gone".into(),
                kind: LibraryFileKind::Games,
                version: 1,
                content_sha256: Some("abc".into()),
            },
        );
        let origin = start_mock_server(Arc::clone(&server)).await;

        let mut cfg = fast_config();
        cfg.scan_interval = Duration::from_millis(50);
        let harness =
            build_harness_with_config(&origin, SyncState::off(), true, &[], cfg.clone()).await;

        // Create an unreadable subdirectory so scans are incomplete initially.
        let blocked_dir = harness.workspace_dir.join("blocked");
        std::fs::create_dir_all(&blocked_dir).unwrap();
        std::fs::set_permissions(&blocked_dir, std::fs::Permissions::from_mode(0o000)).unwrap();

        // Persist a state whose entry is already at ABSENCE_DELETE_THRESHOLD and restart the worker.
        harness.owner.shutdown().await;
        let mut persisted = SyncState {
            version: crate::library_sync::state::STATE_VERSION,
            account_id: Some("acct-1".into()),
            mode: SyncMode::On,
            workspace: Some(harness.workspace.clone()),
            entries: Default::default(),
            pending_deselected_locators: Vec::new(),
        };
        persisted.entries.insert(
            missing_id.into(),
            SyncEntry {
                locator: vec![OsString::from("Gone.pgn")],
                handle: None,
                selected: true,
                last_content_sha256: Some("abc".into()),
                missed_scans: ABSENCE_DELETE_THRESHOLD,
                last_rejection: None,
            },
        );
        persisted.save(&harness.state_dir).unwrap();

        let owner = LibrarySyncOwner::start(
            Arc::clone(&harness.state_dir),
            persisted,
            harness.authority.clone(),
            Arc::new(Mutex::new(())),
            Arc::clone(&harness.account),
            Arc::new(|_| {}),
            cfg,
        );

        // Startup run completes its incomplete scan: must NOT delete, and subsequent incomplete
        // periodic scans must NOT keep listing the server every interval.
        let deadline = Instant::now() + Duration::from_secs(5);
        while server.list_count.load(Ordering::SeqCst) < 1 {
            assert!(Instant::now() < deadline);
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        tokio::time::sleep(Duration::from_millis(130)).await;
        assert_eq!(server.delete_count.load(Ordering::SeqCst), 0);
        assert_eq!(
            server.list_count.load(Ordering::SeqCst),
            1,
            "incomplete periodic scans must not list the server for absence alone"
        );

        // Restore directory readability: next complete periodic scan runs and deletes the file
        // even though the file fingerprint (empty) did not change.
        std::fs::set_permissions(&blocked_dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while server.delete_count.load(Ordering::SeqCst) < 1 {
            assert!(
                Instant::now() < deadline,
                "entry already at threshold was not deleted once scans became complete"
            );
            tokio::time::sleep(Duration::from_millis(15)).await;
        }
        assert_eq!(server.delete_count.load(Ordering::SeqCst), 1);
        assert!(server.files.lock().unwrap().is_empty());

        owner.shutdown().await;
    }

    #[tokio::test]
    async fn oversized_file_is_never_uploaded_and_reported_as_too_large_while_other_files_sync() {
        let server = MockServerState::new("acct-1");
        let origin = start_mock_server(Arc::clone(&server)).await;
        let big_bytes = vec![b' '; (crate::library_sync::wire::LIBRARY_MAX_BYTES + 1) as usize];

        let harness = build_harness_with_config(
            &origin,
            SyncState::off(),
            true,
            &[("Big.pgn", &big_bytes), ("Small.pgn", ALPHA_PGN)],
            fast_config(),
        )
        .await;

        harness
            .owner
            .turn_on(harness.workspace.clone(), vec![])
            .await
            .unwrap();

        let snap = wait_for_state(&harness.owner, &harness.workspace, |s| {
            matches!(s.state, LibrarySyncState::Attention { count: 1 })
        })
        .await;
        assert_eq!(server.put_count.load(Ordering::SeqCst), 1);
        let big = snap.files.iter().find(|f| f.name == "Big").unwrap();
        let small = snap.files.iter().find(|f| f.name == "Small").unwrap();
        assert_eq!(big.status, LibrarySyncFileStatus::TooLarge);
        assert_eq!(small.status, LibrarySyncFileStatus::Synced);

        harness.owner.shutdown().await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn set_file_selected_before_first_list_toggles_both_ways_and_preserves_state_on_write_failure(
    ) {
        use std::os::unix::fs::PermissionsExt;

        let server = MockServerState::new("acct-1");
        server.fail_all_500.store(true, Ordering::SeqCst);
        let origin = start_mock_server(Arc::clone(&server)).await;

        let mut cfg = fast_config();
        cfg.backoff_base = Duration::from_secs(60);
        let harness = build_harness_with_config(
            &origin,
            SyncState::off(),
            true,
            &[("Alpha.pgn", ALPHA_PGN), ("Beta.pgn", BETA_PGN)],
            cfg,
        )
        .await;

        let turn_on_snap = harness
            .owner
            .turn_on(harness.workspace.clone(), vec![])
            .await
            .unwrap();
        let alpha_handle = turn_on_snap
            .files
            .iter()
            .find(|f| f.name == "Alpha")
            .unwrap()
            .handle
            .clone();
        let beta_handle = turn_on_snap
            .files
            .iter()
            .find(|f| f.name == "Beta")
            .unwrap()
            .handle
            .clone();
        wait_for_state(&harness.owner, &harness.workspace, |s| {
            s.state == LibrarySyncState::ServerError
        })
        .await;
        // First list failed -> no entries minted yet.
        assert!(SyncState::load(&harness.state_dir).entries.is_empty());

        // Deselect Alpha before first list, then reselect, then deselect again.
        let s1 = harness
            .owner
            .set_file_selected(harness.workspace.clone(), alpha_handle.clone(), false)
            .await
            .unwrap();
        assert!(
            !s1.files
                .iter()
                .find(|f| f.name == "Alpha")
                .unwrap()
                .selected
        );
        let s2 = harness
            .owner
            .set_file_selected(harness.workspace.clone(), alpha_handle.clone(), true)
            .await
            .unwrap();
        assert!(
            s2.files
                .iter()
                .find(|f| f.name == "Alpha")
                .unwrap()
                .selected
        );
        let s3 = harness
            .owner
            .set_file_selected(harness.workspace.clone(), alpha_handle.clone(), false)
            .await
            .unwrap();
        assert!(
            !s3.files
                .iter()
                .find(|f| f.name == "Alpha")
                .unwrap()
                .selected
        );

        // Failed persist_state in BOTH directions must leave in-memory state unchanged:
        // (1) Alpha: deselected -> selected fails; Alpha stays deselected.
        // (2) Beta: selected -> deselected fails; Beta stays selected in snapshot and is uploaded.
        std::fs::set_permissions(
            harness.state_dir.path(),
            std::fs::Permissions::from_mode(0o500),
        )
        .unwrap();
        let err_select = harness
            .owner
            .set_file_selected(harness.workspace.clone(), alpha_handle, true)
            .await
            .unwrap_err();
        let err_deselect = harness
            .owner
            .set_file_selected(harness.workspace.clone(), beta_handle, false)
            .await
            .unwrap_err();
        std::fs::set_permissions(
            harness.state_dir.path(),
            std::fs::Permissions::from_mode(0o700),
        )
        .unwrap();
        assert_eq!(err_select, LibrarySyncError::LocalStorage);
        assert_eq!(err_deselect, LibrarySyncError::LocalStorage);

        let after_failed_writes = harness
            .owner
            .snapshot(harness.workspace.clone())
            .await
            .unwrap();
        assert!(
            !after_failed_writes
                .files
                .iter()
                .find(|f| f.name == "Alpha")
                .unwrap()
                .selected
        );
        assert!(
            after_failed_writes
                .files
                .iter()
                .find(|f| f.name == "Beta")
                .unwrap()
                .selected
        );

        // Unblock server: first list succeeds; Alpha is NOT uploaded, Beta IS uploaded.
        server.fail_all_500.store(false, Ordering::SeqCst);
        harness
            .owner
            .sync_now(harness.workspace.clone())
            .await
            .unwrap();
        let final_snap = wait_for_state(&harness.owner, &harness.workspace, |s| {
            s.state == LibrarySyncState::Synced
        })
        .await;
        assert_eq!(server.put_count.load(Ordering::SeqCst), 1);
        let alpha_final = final_snap.files.iter().find(|f| f.name == "Alpha").unwrap();
        let beta_final = final_snap.files.iter().find(|f| f.name == "Beta").unwrap();
        assert!(!alpha_final.selected);
        assert_eq!(alpha_final.status, LibrarySyncFileStatus::NotSelected);
        assert!(beta_final.selected);
        assert_eq!(beta_final.status, LibrarySyncFileStatus::Synced);

        harness.owner.shutdown().await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn failed_persist_state_enters_local_error_at_rejection_clear_and_delete_prune() {
        use std::os::unix::fs::PermissionsExt;

        let server = MockServerState::new("acct-1");
        *server.reject_invalid_pgn_name.lock().unwrap() = Some("Alpha".into());
        let origin = start_mock_server(Arc::clone(&server)).await;

        let mut cfg = fast_config();
        cfg.scan_interval = Duration::from_secs(300);
        let harness = build_harness_with_config(
            &origin,
            SyncState::off(),
            true,
            &[("Alpha.pgn", ALPHA_PGN)],
            cfg,
        )
        .await;

        harness
            .owner
            .turn_on(harness.workspace.clone(), vec![])
            .await
            .unwrap();
        wait_for_state(&harness.owner, &harness.workspace, |s| {
            matches!(s.state, LibrarySyncState::Attention { count: 1 })
        })
        .await;

        // 1. Rejection-clear site: edit file so it retries, allow upload, and make state_dir
        // unwritable inside `mock_put` (after the pre-PUT state write succeeded) so the
        // rejection-clear `persist_state` fails and enters LocalError keeping state unchanged.
        std::fs::write(
            harness.workspace_dir.join("Alpha.pgn"),
            b"[Event \"Fixed\"]\n\n1. e4 c5 *\n",
        )
        .unwrap();
        *server.reject_invalid_pgn_name.lock().unwrap() = None;
        let state_dir_for_put = harness.state_dir.path().to_path_buf();
        *server.on_put_success.lock().unwrap() = Some(Box::new(move || {
            std::fs::set_permissions(&state_dir_for_put, std::fs::Permissions::from_mode(0o500))
                .unwrap();
        }));
        let puts_before = server.put_count.load(Ordering::SeqCst);
        harness
            .owner
            .sync_now(harness.workspace.clone())
            .await
            .unwrap();
        wait_for_state(&harness.owner, &harness.workspace, |s| {
            s.state == LibrarySyncState::LocalError
        })
        .await;
        assert_eq!(server.put_count.load(Ordering::SeqCst), puts_before + 1);
        std::fs::set_permissions(
            harness.state_dir.path(),
            std::fs::Permissions::from_mode(0o700),
        )
        .unwrap();
        // First sync_now with no new disk edit performs 0 PUTs and persists in-memory state:
        // `last_rejection` must still be present on disk, proving in-memory state was unchanged.
        harness
            .owner
            .sync_now(harness.workspace.clone())
            .await
            .unwrap();
        wait_for_state(&harness.owner, &harness.workspace, |s| {
            s.state == LibrarySyncState::Synced
        })
        .await;
        assert!(SyncState::load(&harness.state_dir)
            .entries
            .values()
            .next()
            .unwrap()
            .last_rejection
            .is_some());

        // Editing the file again repeats the PUT + rejection-clear step and persists `None`.
        std::fs::write(
            harness.workspace_dir.join("Alpha.pgn"),
            b"[Event \"Fixed 2\"]\n\n1. d4 d5 *\n",
        )
        .unwrap();
        let puts_before_second = server.put_count.load(Ordering::SeqCst);
        harness
            .owner
            .sync_now(harness.workspace.clone())
            .await
            .unwrap();
        wait_for_state(&harness.owner, &harness.workspace, |s| {
            s.state == LibrarySyncState::Synced
                && server.put_count.load(Ordering::SeqCst) > puts_before_second
        })
        .await;
        assert_eq!(
            server.put_count.load(Ordering::SeqCst),
            puts_before_second + 1
        );
        assert!(SyncState::load(&harness.state_dir)
            .entries
            .values()
            .next()
            .unwrap()
            .last_rejection
            .is_none());

        // 2. Delete-prune site: restart with missed_scans already at threshold and make state_dir
        // unwritable inside `mock_delete` (after the pre-DELETE state write succeeded).
        let entry_id = SyncState::load(&harness.state_dir)
            .entries
            .keys()
            .next()
            .unwrap()
            .clone();
        std::fs::remove_file(harness.workspace_dir.join("Alpha.pgn")).unwrap();
        harness.owner.shutdown().await;
        let mut persisted = SyncState::load(&harness.state_dir);
        persisted.entries.get_mut(&entry_id).unwrap().missed_scans = ABSENCE_DELETE_THRESHOLD;
        persisted.save(&harness.state_dir).unwrap();

        let state_dir_for_del = harness.state_dir.path().to_path_buf();
        *server.on_delete_success.lock().unwrap() = Some(Box::new(move || {
            std::fs::set_permissions(&state_dir_for_del, std::fs::Permissions::from_mode(0o500))
                .unwrap();
        }));
        let deletes_before = server.delete_count.load(Ordering::SeqCst);
        let owner = LibrarySyncOwner::start(
            Arc::clone(&harness.state_dir),
            persisted,
            harness.authority.clone(),
            Arc::new(Mutex::new(())),
            Arc::clone(&harness.account),
            Arc::new(|_| {}),
            fast_config(),
        );
        wait_for_state(&owner, &harness.workspace, |s| {
            s.state == LibrarySyncState::LocalError
        })
        .await;
        assert_eq!(
            server.delete_count.load(Ordering::SeqCst),
            deletes_before + 1
        );
        std::fs::set_permissions(
            harness.state_dir.path(),
            std::fs::Permissions::from_mode(0o700),
        )
        .unwrap();
        assert!(SyncState::load(&harness.state_dir)
            .entries
            .contains_key(&entry_id));

        // Re-insert the server file and run sync_now: because in-memory state still holds
        // `entry_id`, the worker repeats the DELETE and then prunes and persists the removal.
        server.files.lock().unwrap().insert(
            entry_id.clone(),
            StudioLibraryFile {
                studio_file_id: entry_id.clone(),
                name: "Alpha".into(),
                kind: LibraryFileKind::Games,
                version: 3,
                content_sha256: Some("sha".into()),
            },
        );
        owner.sync_now(harness.workspace.clone()).await.unwrap();
        wait_for_state(&owner, &harness.workspace, |s| {
            s.state == LibrarySyncState::Synced
        })
        .await;
        assert_eq!(
            server.delete_count.load(Ordering::SeqCst),
            deletes_before + 2
        );
        assert!(!SyncState::load(&harness.state_dir)
            .entries
            .contains_key(&entry_id));
        owner.shutdown().await;
    }

    #[tokio::test]
    async fn backoff_is_kept_while_file_is_absent_and_deletes_after_recovery() {
        let server = MockServerState::new("acct-1");
        let origin = start_mock_server(Arc::clone(&server)).await;

        let mut cfg = fast_config();
        cfg.scan_interval = Duration::from_millis(35);
        cfg.backoff_base = Duration::from_millis(500);
        cfg.backoff_max = Duration::from_millis(1000);
        let harness = build_harness_with_config(
            &origin,
            SyncState::off(),
            true,
            &[("Alpha.pgn", ALPHA_PGN)],
            cfg,
        )
        .await;

        harness
            .owner
            .turn_on(harness.workspace.clone(), vec![])
            .await
            .unwrap();
        wait_for_state(&harness.owner, &harness.workspace, |s| {
            s.state == LibrarySyncState::Synced
        })
        .await;
        assert_eq!(server.put_count.load(Ordering::SeqCst), 1);

        // Remove the file while the server is failing with 500: the first run after removal
        // stores the new empty fingerprint and enters backoff. Subsequent periodic scans during
        // the backoff window must NOT override backoff or hit the server.
        server.fail_all_500.store(true, Ordering::SeqCst);
        std::fs::remove_file(harness.workspace_dir.join("Alpha.pgn")).unwrap();
        wait_for_state(&harness.owner, &harness.workspace, |s| {
            s.state == LibrarySyncState::ServerError
        })
        .await;
        let lists_at_error = server.list_count.load(Ordering::SeqCst);

        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(
            server.list_count.load(Ordering::SeqCst),
            lists_at_error,
            "periodic scan must not override backoff while a file is absent"
        );

        // Recover the server; once backoff elapses the worker retries and deletes the file.
        server.fail_all_500.store(false, Ordering::SeqCst);
        let deadline = Instant::now() + Duration::from_secs(4);
        while Instant::now() < deadline {
            if server.delete_count.load(Ordering::SeqCst) == 1 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        assert_eq!(server.delete_count.load(Ordering::SeqCst), 1);
        wait_for_state(&harness.owner, &harness.workspace, |s| {
            s.state == LibrarySyncState::Synced
        })
        .await;

        harness.owner.shutdown().await;
    }

    #[tokio::test]
    async fn turn_on_other_folder_does_not_inherit_absence() {
        let server = MockServerState::new("acct-1");
        let origin = start_mock_server(Arc::clone(&server)).await;

        let mut cfg = fast_config();
        cfg.scan_interval = Duration::from_millis(40);
        cfg.backoff_base = Duration::from_millis(250);
        let harness = build_harness_with_config(
            &origin,
            SyncState::off(),
            true,
            &[("Alpha.pgn", ALPHA_PGN)],
            cfg,
        )
        .await;

        std::fs::write(
            harness._temp.path().join("other-library").join("Beta.pgn"),
            BETA_PGN,
        )
        .unwrap();
        let workspace2 = harness.other_workspace.clone();

        harness
            .owner
            .turn_on(harness.workspace.clone(), vec![])
            .await
            .unwrap();
        wait_for_state(&harness.owner, &harness.workspace, |s| {
            s.state == LibrarySyncState::Synced
        })
        .await;

        // Remove Alpha in folder 1 and trigger a run so folder 1 has an unmatched entry.
        let lists_before_absence = server.list_count.load(Ordering::SeqCst);
        std::fs::remove_file(harness.workspace_dir.join("Alpha.pgn")).unwrap();
        harness
            .owner
            .sync_now(harness.workspace.clone())
            .await
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            if server.list_count.load(Ordering::SeqCst) > lists_before_absence {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(server.list_count.load(Ordering::SeqCst) > lists_before_absence);

        // Turn sync on for folder 2: once folder 2 is synced, periodic scans must not list again.
        harness
            .owner
            .turn_on(workspace2.clone(), vec![])
            .await
            .unwrap();
        wait_for_state(&harness.owner, &workspace2, |s| {
            s.state == LibrarySyncState::Synced && server.put_count.load(Ordering::SeqCst) == 2
        })
        .await;
        let lists_after_ws2 = server.list_count.load(Ordering::SeqCst);
        tokio::time::sleep(Duration::from_millis(220)).await;
        assert_eq!(
            server.list_count.load(Ordering::SeqCst),
            lists_after_ws2,
            "folder 2 must not inherit unmatched absence from folder 1"
        );

        harness.owner.shutdown().await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn periodic_scan_recovers_from_folder_unavailable_without_file_change() {
        use std::os::unix::fs::PermissionsExt;

        let server = MockServerState::new("acct-1");
        let origin = start_mock_server(Arc::clone(&server)).await;

        let mut cfg = fast_config();
        cfg.scan_interval = Duration::from_millis(40);
        cfg.backoff_base = Duration::from_secs(60);
        let harness = build_harness_with_config(
            &origin,
            SyncState::off(),
            true,
            &[("Alpha.pgn", ALPHA_PGN)],
            cfg,
        )
        .await;

        harness
            .owner
            .turn_on(harness.workspace.clone(), vec![])
            .await
            .unwrap();
        wait_for_state(&harness.owner, &harness.workspace, |s| {
            s.state == LibrarySyncState::Synced
        })
        .await;

        // Make the folder unreadable so periodic_scan_check publishes FolderUnavailable.
        std::fs::set_permissions(
            &harness.workspace_dir,
            std::fs::Permissions::from_mode(0o000),
        )
        .unwrap();
        wait_for_state(&harness.owner, &harness.workspace, |s| {
            s.state == LibrarySyncState::FolderUnavailable
        })
        .await;

        // Restore permissions with nothing changed: periodic scan must recover to Synced.
        std::fs::set_permissions(
            &harness.workspace_dir,
            std::fs::Permissions::from_mode(0o700),
        )
        .unwrap();
        wait_for_state(&harness.owner, &harness.workspace, |s| {
            s.state == LibrarySyncState::Synced
        })
        .await;

        harness.owner.shutdown().await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn pending_deselection_survives_incomplete_first_scan() {
        use std::os::unix::fs::PermissionsExt;

        let server = MockServerState::new("acct-1");
        server.fail_all_500.store(true, Ordering::SeqCst);
        let origin = start_mock_server(Arc::clone(&server)).await;

        let mut cfg = fast_config();
        cfg.scan_interval = Duration::from_secs(300);
        cfg.backoff_base = Duration::from_secs(60);
        let harness = build_harness_with_config(
            &origin,
            SyncState::off(),
            true,
            &[("Alpha.pgn", ALPHA_PGN)],
            cfg,
        )
        .await;

        let sub_dir = harness.workspace_dir.join("sub");
        std::fs::create_dir(&sub_dir).unwrap();
        std::fs::write(sub_dir.join("Hidden.pgn"), BETA_PGN).unwrap();

        let off_snap = harness
            .owner
            .snapshot(harness.workspace.clone())
            .await
            .unwrap();
        let hidden_handle = off_snap
            .files
            .iter()
            .find(|f| f.name == "Hidden")
            .unwrap()
            .handle
            .clone();

        // Turn on with Hidden deselected while the server is returning 500 so entries are not
        // minted yet and the deselection remains in the pending sets.
        harness
            .owner
            .turn_on(harness.workspace.clone(), vec![hidden_handle])
            .await
            .unwrap();
        wait_for_state(&harness.owner, &harness.workspace, |s| {
            s.state == LibrarySyncState::ServerError
        })
        .await;

        // Make `sub` unreadable during the first successful run (incomplete scan omits Hidden).
        std::fs::set_permissions(&sub_dir, std::fs::Permissions::from_mode(0o000)).unwrap();
        server.fail_all_500.store(false, Ordering::SeqCst);
        harness
            .owner
            .sync_now(harness.workspace.clone())
            .await
            .unwrap();
        wait_for_state(&harness.owner, &harness.workspace, |s| {
            s.state == LibrarySyncState::Synced
        })
        .await;
        assert_eq!(server.put_count.load(Ordering::SeqCst), 1);

        // Make `sub` readable again and sync: Hidden must be minted deselected and never uploaded.
        std::fs::set_permissions(&sub_dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        harness
            .owner
            .sync_now(harness.workspace.clone())
            .await
            .unwrap();
        let final_snap = wait_for_state(&harness.owner, &harness.workspace, |s| {
            s.state == LibrarySyncState::Synced && s.files.iter().any(|f| f.name == "Hidden")
        })
        .await;
        assert_eq!(
            server.put_count.load(Ordering::SeqCst),
            1,
            "file deselected at turn-on inside an unreadable folder must not be uploaded later"
        );
        let hidden = final_snap
            .files
            .iter()
            .find(|f| f.name == "Hidden")
            .unwrap();
        assert!(!hidden.selected);
        assert_eq!(hidden.status, LibrarySyncFileStatus::NotSelected);

        harness.owner.shutdown().await;
    }

    #[test]
    fn resolve_account_connected_keeps_last_known_on_busy_and_storage() {
        assert!(resolve_account_connected(Ok(true), false));
        assert!(!resolve_account_connected(Ok(false), true));
        assert!(resolve_account_connected(Err(AccountError::Busy), true));
        assert!(!resolve_account_connected(Err(AccountError::Busy), false));
        assert!(resolve_account_connected(Err(AccountError::Storage), true));
        assert!(!resolve_account_connected(
            Err(AccountError::Storage),
            false
        ));
        assert!(!resolve_account_connected(
            Err(AccountError::NotConnected),
            true
        ));
    }
}
