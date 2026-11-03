use std::{
    collections::HashMap,
    future::Future,
    sync::{Arc, Condvar, Mutex, MutexGuard},
    time::{Duration, Instant},
};

use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use futures_util::FutureExt;

pub(crate) mod accounts;
pub mod completions;

use self::completions::{
    CompletionOutcome, EngineCompletion, EngineCompletionEntry, EngineInstallIntent,
    EngineInstallRequest, InstalledEngineResult,
};
use crate::error::Error;

#[derive(Debug)]
pub(crate) struct RuntimeDownload {
    pub(crate) publication: crate::infra::path_authority::ArtifactPublication,
    pub(crate) receipt_error: Option<Error>,
    pub(crate) coverage_holds: Option<Vec<crate::lichess::CoverageHold>>,
}

pub const READ_RESERVATION_TTL: Duration = Duration::from_secs(60);
pub const MAX_NATIVE_READS: usize = 128;
pub const MAX_ACCEPTED_OPERATIONS: usize = 128;

#[cfg(test)]
static COMMIT_BEFORE_HOOKS: crate::infra::test_hooks::KeyedTestHooks<String> =
    crate::infra::test_hooks::KeyedTestHooks::new();
#[cfg(test)]
static COMMIT_AFTER_HOOKS: crate::infra::test_hooks::KeyedTestHooks<String> =
    crate::infra::test_hooks::KeyedTestHooks::new();

enum ReadState {
    Reserved {
        created_at: Instant,
    },
    CancelledReserved {
        created_at: Instant,
    },
    Active {
        cancellation: CancellationToken,
        label: String,
    },
}

struct ReadEntry {
    owner: String,
    kind: ReservationKindOwned,
    state: ReadState,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum ReservationKindOwned {
    Read,
    Analysis { tab: String },
    Download,
    Conversion,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CancelledOperationKind {
    Read,
    Analysis,
    Download,
    Conversion,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct CancelledOperation {
    pub id: String,
    pub kind: CancelledOperationKind,
}

#[derive(Clone, Copy)]
enum ReservationKind<'a> {
    Read,
    Analysis { tab: &'a str },
    Download,
    Conversion,
}

struct PreparedReservationClaim<'a> {
    ticket: &'a str,
    owner: &'a str,
    label: &'a str,
    kind: ReservationKind<'a>,
    download_policy: Option<(&'a str, &'a str, bool, usize)>,
}

impl<'a> ReservationKind<'a> {
    fn owned(self) -> ReservationKindOwned {
        match self {
            Self::Read => ReservationKindOwned::Read,
            Self::Analysis { tab } => ReservationKindOwned::Analysis {
                tab: tab.to_owned(),
            },
            Self::Download => ReservationKindOwned::Download,
            Self::Conversion => ReservationKindOwned::Conversion,
        }
    }

    fn lease_kind(self) -> LeaseKind {
        match self {
            Self::Read => LeaseKind::Read,
            Self::Analysis { .. } => LeaseKind::Analysis,
            Self::Download | Self::Conversion => LeaseKind::Accepted,
        }
    }

    fn capacity_error(self) -> &'static str {
        match self {
            Self::Read => "too many native read operations",
            Self::Analysis { .. } => "too many prepared analysis operations",
            Self::Download => "too many download reservations",
            Self::Conversion => "too many conversion reservations",
        }
    }

    fn unknown_error(self) -> &'static str {
        match self {
            Self::Read => "native read reservation is unknown or expired",
            Self::Analysis { .. } => "analysis reservation is unknown or expired",
            Self::Download => "download reservation is unknown or expired",
            Self::Conversion => "conversion reservation is unknown or expired",
        }
    }

    fn owner_error(self) -> &'static str {
        match self {
            Self::Read => "native read reservation belongs to another webview",
            Self::Analysis { .. } => "analysis reservation belongs to another webview or tab",
            Self::Download => "download reservation belongs to another webview",
            Self::Conversion => "conversion reservation belongs to another webview",
        }
    }

    fn wrong_kind_error(self, cancelling: bool) -> &'static str {
        match (self, cancelling) {
            (Self::Conversion, false) => "reservation cannot be claimed as a conversion",
            (Self::Conversion, true) => "reservation cannot be cancelled as a conversion",
            (Self::Read, false) => "analysis reservation cannot be claimed as a native read",
            (Self::Read, true) => "analysis reservation cannot be cancelled as a native read",
            (Self::Analysis { .. }, false) => {
                "native read reservation cannot be claimed as an analysis"
            }
            (Self::Analysis { .. }, true) => {
                "native read reservation cannot be cancelled as an analysis"
            }
            (Self::Download, false) => {
                "native read or analysis reservation cannot be claimed as a download"
            }
            (Self::Download, true) => {
                "native read or analysis reservation cannot be cancelled as a download"
            }
        }
    }

    fn claimed_error(self) -> &'static str {
        match self {
            Self::Read => "native read reservation was already claimed",
            Self::Analysis { .. } => "analysis reservation was already claimed",
            Self::Download => "download reservation was already claimed",
            Self::Conversion => "conversion reservation was already claimed",
        }
    }
}

#[derive(Default)]
struct RegistryState {
    reads: HashMap<String, ReadEntry>,
    accepted: HashMap<String, AcceptedEntry>,
    completions: HashMap<String, EngineCompletionEntry>,
    accounts: HashMap<String, accounts::AccountCompletionEntry>,
    sealed: bool,
}

struct AcceptedEntry {
    owner: String,
    label: String,
    cancellation: CancellationToken,
    kind: Option<ReservationKindOwned>,
    progress_id: Option<String>,
    admission_key: Option<String>,
    committing: bool,
}

impl AcceptedEntry {
    fn is_download(&self) -> bool {
        self.kind == Some(ReservationKindOwned::Download)
    }
}

struct RegistryInner {
    state: Mutex<RegistryState>,
    changed: Condvar,
}

/// Native authority for transient renderer requests and application-owned accepted operations.
/// Reservations are bounded and expire lazily; active leases are never evicted or reused.
#[derive(Clone)]
pub struct OperationRegistry {
    inner: Arc<RegistryInner>,
    reservation_ttl: Duration,
}

impl Default for OperationRegistry {
    fn default() -> Self {
        Self {
            inner: Arc::new(RegistryInner {
                state: Mutex::new(RegistryState::default()),
                changed: Condvar::new(),
            }),
            reservation_ttl: READ_RESERVATION_TTL,
        }
    }
}

impl OperationRegistry {
    fn occupied(state: &RegistryState) -> usize {
        state.accepted.len()
            + state
                .completions
                .iter()
                .filter(|(id, entry)| {
                    !state.accepted.contains_key(*id)
                        && !state.accepted.contains_key(&entry.operation_id)
                })
                .count()
    }

    #[cfg(test)]
    pub(crate) fn accept_completion_tail(
        &self,
        id: &str,
        owner: &str,
    ) -> Result<OperationLease, Error> {
        let mut state = self.state()?;
        self.accept_completion_tail_in_state(&mut state, id, owner)
    }

    fn accept_completion_tail_in_state(
        &self,
        state: &mut RegistryState,
        id: &str,
        owner: &str,
    ) -> Result<OperationLease, Error> {
        if state.sealed
            || state.accepted.contains_key(id)
            || !state
                .completions
                .get(id)
                .is_some_and(|entry| entry.owner == owner)
        {
            return Err(Error::Conflict("completion tail is unavailable".into()));
        }
        let cancellation = CancellationToken::new();
        state.accepted.insert(
            id.to_owned(),
            AcceptedEntry {
                owner: owner.to_owned(),
                label: "engine completion application".into(),
                cancellation: cancellation.clone(),
                kind: None,
                progress_id: None,
                admission_key: None,
                committing: true,
            },
        );
        Ok(OperationLease {
            registry: self.inner.clone(),
            id: id.to_owned(),
            cancellation,
            kind: LeaseKind::Accepted,
        })
    }

    /// Admission and the immutable request share the accepted-operation lock. Reusing an ID
    /// joins exactly that request. An unfinished upgrade excludes every later upgrade of its UUID.
    pub(crate) fn admit_engine_completion(
        &self,
        id: &str,
        owner: &str,
        ticket: &str,
        request: EngineInstallRequest,
        download_cap: usize,
    ) -> Result<(EngineCompletion, Option<OperationLease>), Error> {
        request.validate(id)?;
        let mut state = self.state()?;
        if let Some(existing) = state.completions.get(id) {
            if existing.owner != owner || existing.snapshot.request != request {
                return Err(Error::Conflict(
                    "completion identity belongs to another request".into(),
                ));
            }
            return Ok((existing.snapshot.clone(), None));
        }
        if state.completions.len() >= MAX_ACCEPTED_OPERATIONS {
            return Err(Error::ResourceLimit(
                "too many unacknowledged completions".into(),
            ));
        }
        if state.completions.values().any(|entry| {
            matches!(
                entry.snapshot.request.intent,
                EngineInstallIntent::Upgrade { .. }
            ) && entry.snapshot.request.intent.engine_id() == request.intent.engine_id()
        }) {
            return Err(Error::Conflict(
                "engine upgrade application is pending".into(),
            ));
        }
        let lease = self.claim_prepared_in_state(
            &mut state,
            PreparedReservationClaim {
                ticket,
                owner,
                label: "install_engine_workflow",
                kind: ReservationKind::Download,
                download_policy: Some((
                    &request.progress_id,
                    &request.progress_id,
                    false,
                    download_cap,
                )),
            },
        )?;
        let snapshot = EngineCompletion {
            id: id.to_owned(),
            request,
            outcome: CompletionOutcome::Running,
            retired: false,
        };
        state.completions.insert(
            id.to_owned(),
            EngineCompletionEntry {
                owner: owner.to_owned(),
                operation_id: ticket.to_owned(),
                snapshot: snapshot.clone(),
                progress: None,
                retirement: Arc::default(),
                retirement_job: None,
                acknowledgement_job: None,
            },
        );
        Ok((snapshot, Some(lease)))
    }

    pub(crate) fn engine_completions(&self, owner: &str) -> Result<Vec<EngineCompletion>, Error> {
        let state = self.state()?;
        Ok(state
            .completions
            .values()
            .filter(|entry| entry.owner == owner)
            .map(|entry| entry.snapshot.clone())
            .collect())
    }

    #[cfg(test)]
    pub(crate) fn engine_completion(
        &self,
        id: &str,
        owner: &str,
    ) -> Result<EngineCompletion, Error> {
        let state = self.state()?;
        let entry = state
            .completions
            .get(id)
            .filter(|entry| entry.owner == owner)
            .ok_or_else(|| Error::Conflict("completion is unavailable".into()))?;
        Ok(entry.snapshot.clone())
    }

    pub(crate) fn set_engine_completion_progress(
        &self,
        id: &str,
        progress: crate::progress::ProgressLease,
    ) -> Result<(), Error> {
        let mut state = self.state()?;
        let entry = state
            .completions
            .get_mut(id)
            .ok_or_else(|| Error::Conflict("completion is unavailable".into()))?;
        entry.progress = Some(progress);
        Ok(())
    }

    pub(crate) fn finish_engine_completion(
        &self,
        id: &str,
        result: &Result<InstalledEngineResult, Error>,
    ) -> Result<EngineCompletion, Error> {
        let mut state = self.state()?;
        let entry = state
            .completions
            .get_mut(id)
            .ok_or_else(|| Error::Conflict("completion is unavailable".into()))?;
        entry.snapshot.outcome = match result {
            Ok(result) => CompletionOutcome::Succeeded(result.clone()),
            Err(error) => CompletionOutcome::Failed(error.renderer_payload()),
        };
        Ok(entry.snapshot.clone())
    }

    pub(crate) fn begin_engine_application(
        &self,
        id: &str,
        owner: &str,
        step: completions::EngineApplicationStep,
    ) -> Result<completions::CompletionAdmission, Error> {
        use completions::EngineApplicationStep;
        let mut state = self.state()?;
        let Some(entry) = state.completions.get(id) else {
            return Ok((futures_util::future::ready(Ok(())).boxed().shared(), None));
        };
        if entry.owner != owner {
            return Err(Error::Conflict(
                "completion belongs to another webview".into(),
            ));
        }
        if matches!(step, EngineApplicationStep::Retirement)
            && !matches!(entry.snapshot.outcome, CompletionOutcome::Succeeded(_))
        {
            return Err(Error::Conflict(
                "completion is not ready for application".into(),
            ));
        }
        if matches!(step, EngineApplicationStep::Acknowledgement)
            && (matches!(entry.snapshot.outcome, CompletionOutcome::Running)
                || (matches!(entry.snapshot.outcome, CompletionOutcome::Succeeded(_))
                    && matches!(
                        entry.snapshot.request.intent,
                        EngineInstallIntent::Upgrade { .. }
                    )
                    && !entry.snapshot.retired))
        {
            return Err(Error::Conflict(
                "completion application is unfinished".into(),
            ));
        }
        let existing = match step {
            EngineApplicationStep::Retirement => &entry.retirement_job,
            EngineApplicationStep::Acknowledgement => &entry.acknowledgement_job,
        };
        if let Some(job) = existing {
            if job.peek().is_none() || state.accepted.contains_key(id) {
                return Ok((job.clone(), None));
            }
        }
        if matches!(step, EngineApplicationStep::Retirement) && entry.snapshot.retired {
            return Ok((futures_util::future::ready(Ok(())).boxed().shared(), None));
        }
        let snapshot = entry.snapshot.clone();
        let retirement = entry.retirement.clone();
        let lease = self.accept_completion_tail_in_state(&mut state, id, owner)?;
        let (result, receiver) = tokio::sync::oneshot::channel();
        let job = async move {
            receiver.await.unwrap_or_else(|_| {
                Err(Arc::new(Error::Conflict(
                    "completion application result unavailable".into(),
                )))
            })
        }
        .boxed()
        .shared();
        if let Some(entry) = state.completions.get_mut(id) {
            match step {
                EngineApplicationStep::Retirement => entry.retirement_job = Some(job.clone()),
                EngineApplicationStep::Acknowledgement => {
                    entry.acknowledgement_job = Some(job.clone())
                }
            }
        }
        Ok((
            job,
            Some(completions::CompletionApplicationStart {
                snapshot,
                retirement,
                lease,
                result,
            }),
        ))
    }

    pub(crate) fn finish_engine_retirement(&self, id: &str, owner: &str) -> Result<(), Error> {
        let mut state = self.state()?;
        let entry = state
            .completions
            .get_mut(id)
            .filter(|entry| entry.owner == owner)
            .ok_or_else(|| Error::Conflict("completion is unavailable".into()))?;
        entry.snapshot.retired = true;
        Ok(())
    }

    pub(crate) fn acknowledge_engine_completion(
        &self,
        id: &str,
        owner: &str,
    ) -> Result<Option<crate::progress::ProgressLease>, Error> {
        let mut state = self.state()?;
        let Some(entry) = state.completions.get(id) else {
            return Ok(None);
        };
        if entry.owner != owner {
            return Err(Error::Conflict(
                "completion belongs to another webview".into(),
            ));
        }
        if matches!(entry.snapshot.outcome, CompletionOutcome::Running)
            || (matches!(entry.snapshot.outcome, CompletionOutcome::Succeeded(_))
                && matches!(
                    entry.snapshot.request.intent,
                    EngineInstallIntent::Upgrade { .. }
                )
                && !entry.snapshot.retired)
        {
            return Err(Error::Conflict(
                "completion application is unfinished".into(),
            ));
        }
        Ok(state
            .completions
            .remove(id)
            .and_then(|entry| entry.progress))
    }

    #[cfg(test)]
    pub(crate) fn with_reservation_ttl(reservation_ttl: Duration) -> Self {
        Self {
            reservation_ttl,
            ..Self::default()
        }
    }

    fn state(&self) -> Result<MutexGuard<'_, RegistryState>, Error> {
        self.inner
            .state
            .lock()
            .map_err(|_| Error::Conflict("native operation registry poisoned".into()))
    }

    fn purge_expired(state: &mut RegistryState, now: Instant, ttl: Duration) {
        state.reads.retain(|_, entry| {
            !matches!(entry.state, ReadState::Reserved { created_at } | ReadState::CancelledReserved { created_at } if now.saturating_duration_since(created_at) >= ttl)
        });
    }

    fn prepare_reservation(&self, owner: &str, kind: ReservationKind<'_>) -> Result<String, Error> {
        let mut state = self.state()?;
        Self::purge_expired(&mut state, Instant::now(), self.reservation_ttl);
        if state.sealed {
            return Err(Error::Conflict(
                "native operation admission is sealed".into(),
            ));
        }
        if state.reads.len() >= MAX_NATIVE_READS {
            return Err(Error::ResourceLimit(kind.capacity_error().into()));
        }
        let ticket = Uuid::new_v4().to_string();
        state.reads.insert(
            ticket.clone(),
            ReadEntry {
                owner: owner.to_owned(),
                kind: kind.owned(),
                state: ReadState::Reserved {
                    created_at: Instant::now(),
                },
            },
        );
        Ok(ticket)
    }

    fn claim_reservation(
        &self,
        ticket: &str,
        owner: &str,
        kind: ReservationKind<'_>,
        label: &str,
    ) -> Result<OperationLease, Error> {
        let mut state = self.state()?;
        Self::purge_expired(&mut state, Instant::now(), self.reservation_ttl);
        if state.sealed {
            return Err(Error::Conflict(
                "native operation admission is sealed".into(),
            ));
        }
        let entry = state
            .reads
            .get_mut(ticket)
            .ok_or_else(|| Error::Conflict(kind.unknown_error().into()))?;
        match kind {
            ReservationKind::Read if entry.owner != owner => {
                return Err(Error::Conflict(kind.owner_error().into()));
            }
            ReservationKind::Read if !matches!(entry.kind, ReservationKindOwned::Read) => {
                return Err(Error::Conflict(kind.wrong_kind_error(false).into()));
            }
            ReservationKind::Analysis { tab }
                if entry.owner != owner
                    || !matches!(&entry.kind, ReservationKindOwned::Analysis { tab: entry_tab } if entry_tab == tab) =>
            {
                return Err(Error::Conflict(kind.owner_error().into()));
            }
            _ => {}
        }
        if !matches!(entry.state, ReadState::Reserved { .. }) {
            return Err(Error::Conflict(kind.claimed_error().into()));
        }
        let cancellation = CancellationToken::new();
        entry.state = ReadState::Active {
            cancellation: cancellation.clone(),
            label: label.to_owned(),
        };
        Ok(OperationLease {
            registry: Arc::clone(&self.inner),
            id: ticket.to_owned(),
            cancellation,
            kind: kind.lease_kind(),
        })
    }

    fn cancel_reservation(
        &self,
        ticket: &str,
        owner: &str,
        requested_analysis: bool,
    ) -> Result<(), Error> {
        let mut state = self.state()?;
        Self::purge_expired(&mut state, Instant::now(), self.reservation_ttl);
        let Some(entry) = state.reads.get(ticket) else {
            return Ok(());
        };
        if entry.owner != owner {
            let message = if requested_analysis {
                "analysis reservation belongs to another webview"
            } else {
                "native read reservation belongs to another webview"
            };
            return Err(Error::Conflict(message.into()));
        }
        if requested_analysis {
            if !matches!(entry.kind, ReservationKindOwned::Analysis { .. }) {
                return Err(Error::Conflict(
                    ReservationKind::Analysis { tab: "" }
                        .wrong_kind_error(true)
                        .into(),
                ));
            }
            Self::cancel_entry(&mut state, ticket);
        } else {
            if !matches!(entry.kind, ReservationKindOwned::Read) {
                return Err(Error::Conflict(
                    "download reservation cannot be cancelled as a native read".into(),
                ));
            }
            Self::cancel_entry(&mut state, ticket);
        }
        Ok(())
    }

    fn cancel_entry(state: &mut RegistryState, ticket: &str) {
        if let Some(entry) = state.reads.get(ticket) {
            match &entry.state {
                ReadState::Reserved { .. } | ReadState::CancelledReserved { .. } => {
                    state.reads.remove(ticket);
                }
                ReadState::Active { cancellation, .. } => cancellation.cancel(),
            }
        }
    }

    pub fn prepare_read(&self, owner: &str) -> Result<String, Error> {
        self.prepare_reservation(owner, ReservationKind::Read)
    }

    pub fn claim_read(
        &self,
        ticket: &str,
        owner: &str,
        label: &str,
    ) -> Result<OperationLease, Error> {
        self.claim_reservation(ticket, owner, ReservationKind::Read, label)
    }

    pub fn accept(&self, label: &str) -> Result<OperationLease, Error> {
        self.accept_bounded_with_id(&Uuid::new_v4().to_string(), label)
    }

    fn accept_bounded_with_id(&self, id: &str, label: &str) -> Result<OperationLease, Error> {
        let mut state = self.state()?;
        self.accept_in_state(&mut state, id, label)
    }

    fn accept_in_state(
        &self,
        state: &mut RegistryState,
        id: &str,
        label: &str,
    ) -> Result<OperationLease, Error> {
        if state.sealed {
            return Err(Error::Conflict(
                "native operation admission is sealed".into(),
            ));
        }
        if Self::occupied(state) >= MAX_ACCEPTED_OPERATIONS {
            return Err(Error::ResourceLimit(
                "too many accepted native operations".into(),
            ));
        }
        if state.accepted.contains_key(id) {
            return Err(Error::Conflict("native operation is already active".into()));
        }
        let cancellation = CancellationToken::new();
        state.accepted.insert(
            id.to_owned(),
            AcceptedEntry {
                owner: String::new(),
                label: label.to_owned(),
                cancellation: cancellation.clone(),
                kind: None,
                progress_id: None,
                admission_key: None,
                committing: false,
            },
        );
        Ok(OperationLease {
            registry: Arc::clone(&self.inner),
            id: id.to_owned(),
            cancellation,
            kind: LeaseKind::Accepted,
        })
    }

    pub fn prepare_download(&self, owner: &str) -> Result<String, Error> {
        self.prepare_reservation(owner, ReservationKind::Download)
    }

    #[allow(clippy::too_many_arguments)] // Progress identity and admission policy are independent.
    pub fn claim_download(
        &self,
        ticket: &str,
        owner: &str,
        label: &str,
        progress_id: &str,
        admission_key: &str,
        exclusive: bool,
        download_cap: usize,
    ) -> Result<OperationLease, Error> {
        self.claim_prepared(
            ticket,
            owner,
            label,
            ReservationKind::Download,
            Some((progress_id, admission_key, exclusive, download_cap)),
        )
    }

    pub fn prepare_conversion(&self, owner: &str) -> Result<String, Error> {
        self.prepare_reservation(owner, ReservationKind::Conversion)
    }

    pub fn claim_conversion(&self, ticket: &str, owner: &str) -> Result<OperationLease, Error> {
        self.claim_prepared(
            ticket,
            owner,
            "convert_pgn",
            ReservationKind::Conversion,
            None,
        )
    }

    fn claim_prepared(
        &self,
        ticket: &str,
        owner: &str,
        label: &str,
        kind: ReservationKind<'_>,
        download_policy: Option<(&str, &str, bool, usize)>,
    ) -> Result<OperationLease, Error> {
        let mut state = self.state()?;
        self.claim_prepared_in_state(
            &mut state,
            PreparedReservationClaim {
                ticket,
                owner,
                label,
                kind,
                download_policy,
            },
        )
    }

    fn claim_prepared_in_state(
        &self,
        state: &mut RegistryState,
        claim: PreparedReservationClaim<'_>,
    ) -> Result<OperationLease, Error> {
        let PreparedReservationClaim {
            ticket,
            owner,
            label,
            kind,
            download_policy,
        } = claim;
        Self::purge_expired(state, Instant::now(), self.reservation_ttl);
        if state.sealed {
            return Err(Error::Conflict(
                "native operation admission is sealed".into(),
            ));
        }
        let entry = state
            .reads
            .get(ticket)
            .ok_or_else(|| Error::Conflict(kind.unknown_error().into()))?;
        if entry.owner != owner {
            return Err(Error::Conflict(kind.owner_error().into()));
        }
        if entry.kind != kind.owned() {
            return Err(Error::Conflict(kind.wrong_kind_error(false).into()));
        }
        if matches!(entry.state, ReadState::CancelledReserved { .. }) {
            state.reads.remove(ticket);
            return Err(Error::Cancellation);
        }
        if !matches!(entry.state, ReadState::Reserved { .. }) {
            return Err(Error::Conflict(kind.claimed_error().into()));
        }
        if let Some((_, admission_key, exclusive, download_cap)) = download_policy {
            if state.accepted.values().any(|accepted| {
                accepted.is_download()
                    && (exclusive || accepted.owner == owner)
                    && accepted.admission_key.as_deref() == Some(admission_key)
                    && !accepted.cancellation.is_cancelled()
            }) {
                return Err(Error::Conflict(
                    "download progress is already active".into(),
                ));
            }
            if state
                .accepted
                .values()
                .filter(|accepted| accepted.is_download())
                .count()
                >= download_cap
            {
                return Err(Error::ResourceLimit("too many active downloads".into()));
            }
        }
        if Self::occupied(state) >= MAX_ACCEPTED_OPERATIONS {
            return Err(Error::ResourceLimit(
                "too many accepted native operations".into(),
            ));
        }
        if state.accepted.contains_key(ticket) {
            return Err(Error::Conflict("native operation is already active".into()));
        }
        state.reads.remove(ticket);
        let cancellation = CancellationToken::new();
        state.accepted.insert(
            ticket.to_owned(),
            AcceptedEntry {
                owner: owner.to_owned(),
                label: label.to_owned(),
                cancellation: cancellation.clone(),
                kind: Some(kind.owned()),
                progress_id: download_policy.map(|(progress_id, _, _, _)| progress_id.to_owned()),
                admission_key: download_policy
                    .map(|(_, admission_key, _, _)| admission_key.to_owned()),
                committing: false,
            },
        );
        Ok(OperationLease {
            registry: Arc::clone(&self.inner),
            id: ticket.to_owned(),
            cancellation,
            kind: LeaseKind::Accepted,
        })
    }

    pub fn cancel_download(&self, ticket: &str, owner: &str) -> Result<bool, Error> {
        self.cancel_prepared(ticket, owner, ReservationKind::Download)
    }

    pub fn cancel_conversion(&self, ticket: &str, owner: &str) -> Result<bool, Error> {
        self.cancel_prepared(ticket, owner, ReservationKind::Conversion)
    }

    fn cancel_prepared(
        &self,
        ticket: &str,
        owner: &str,
        kind: ReservationKind<'_>,
    ) -> Result<bool, Error> {
        let mut state = self.state()?;
        Self::purge_expired(&mut state, Instant::now(), self.reservation_ttl);
        if let Some(entry) = state.reads.get(ticket) {
            if entry.owner != owner {
                return Err(Error::Conflict(kind.owner_error().into()));
            }
            if entry.kind != kind.owned() {
                return Err(Error::Conflict(kind.wrong_kind_error(true).into()));
            }
            match entry.state {
                ReadState::Reserved { .. } => {
                    if let Some(entry) = state.reads.get_mut(ticket) {
                        entry.state = ReadState::CancelledReserved {
                            created_at: Instant::now(),
                        };
                    }
                    return Ok(true);
                }
                ReadState::CancelledReserved { .. } => return Ok(true),
                ReadState::Active { .. } => {
                    return Err(Error::Conflict(kind.claimed_error().into()))
                }
            }
        }
        let Some(entry) = state.accepted.get(ticket) else {
            return Ok(false);
        };
        if !Self::accepted_matches(entry, kind) {
            return Err(Error::Conflict(kind.wrong_kind_error(true).into()));
        }
        if entry.owner != owner {
            return Err(Error::Conflict(kind.owner_error().into()));
        }
        if entry.is_download() {
            Ok(Self::cancel_accepted_download(entry))
        } else {
            entry.cancellation.cancel();
            Ok(true)
        }
    }

    fn accepted_matches(entry: &AcceptedEntry, kind: ReservationKind<'_>) -> bool {
        match kind {
            ReservationKind::Download => entry.is_download(),
            ReservationKind::Conversion => entry.kind == Some(ReservationKindOwned::Conversion),
            _ => false,
        }
    }

    fn cancel_accepted_download(entry: &AcceptedEntry) -> bool {
        if entry.committing {
            return false;
        }
        entry.cancellation.cancel();
        true
    }

    pub fn cancel_download_for_progress(
        &self,
        progress_id: &str,
        owner: &str,
    ) -> Result<bool, Error> {
        let state = self.state()?;
        let mut already_cancelled = false;
        for entry in state.accepted.values().filter(|entry| {
            entry.is_download()
                && entry.owner == owner
                && entry.progress_id.as_deref() == Some(progress_id)
        }) {
            if entry.cancellation.is_cancelled() {
                already_cancelled = true;
                continue;
            }
            return Ok(Self::cancel_accepted_download(entry));
        }
        Ok(already_cancelled)
    }

    /// Excludes download admission while deciding whether to clear its progress.
    /// Lock order is registry -> progress store: progress store/lease paths never lock
    /// the registry, and this module's other production paths never lock the progress store.
    /// The closure must do only in-memory work, with no await, I/O, or registry reentry.
    pub fn with_live_download_for_progress<R>(
        &self,
        progress_id: &str,
        decide: impl FnOnce(bool) -> R,
    ) -> Result<R, Error> {
        let state = self.state()?;
        let live_download = state.accepted.values().any(|entry| {
            entry.is_download()
                && entry.progress_id.as_deref() == Some(progress_id)
                && !entry.cancellation.is_cancelled()
        });
        Ok(decide(live_download))
    }

    pub fn release_download(&self, ticket: &str, owner: &str) -> Result<(), Error> {
        self.release_prepared(ticket, owner, ReservationKind::Download)
    }

    pub fn release_conversion(&self, ticket: &str, owner: &str) -> Result<(), Error> {
        self.release_prepared(ticket, owner, ReservationKind::Conversion)
    }

    fn release_prepared(
        &self,
        ticket: &str,
        owner: &str,
        kind: ReservationKind<'_>,
    ) -> Result<(), Error> {
        let mut state = self.state()?;
        Self::purge_expired(&mut state, Instant::now(), self.reservation_ttl);
        if let Some(entry) = state.reads.get(ticket) {
            if entry.owner != owner {
                return Err(Error::Conflict(kind.owner_error().into()));
            }
            if entry.kind != kind.owned() {
                return Err(Error::Conflict(kind.wrong_kind_error(true).into()));
            }
            state.reads.remove(ticket);
            return Ok(());
        }
        if let Some(entry) = state.accepted.get(ticket) {
            if !Self::accepted_matches(entry, kind) || entry.owner != owner {
                return Err(Error::Conflict(kind.owner_error().into()));
            }
        }
        Ok(())
    }

    pub fn prepare_analysis(&self, owner: &str, tab: &str) -> Result<String, Error> {
        self.prepare_reservation(owner, ReservationKind::Analysis { tab })
    }

    pub fn claim_analysis(
        &self,
        ticket: &str,
        owner: &str,
        tab: &str,
        label: &str,
    ) -> Result<OperationLease, Error> {
        self.claim_reservation(ticket, owner, ReservationKind::Analysis { tab }, label)
    }

    pub fn cancel_analysis(&self, ticket: &str, owner: &str) -> Result<(), Error> {
        self.cancel_reservation(ticket, owner, true)
    }

    pub fn cancel_analyses_for_tab(&self, owner: &str, tab: &str) -> Result<Vec<String>, Error> {
        let mut state = self.state()?;
        let tickets: Vec<_> = state
            .reads
            .iter()
            .filter(|(_, entry)| {
                entry.owner == owner
                    && matches!(&entry.kind, ReservationKindOwned::Analysis { tab: entry_tab } if entry_tab == tab)
            })
            .map(|(ticket, _)| ticket.clone())
            .collect();
        for ticket in &tickets {
            Self::cancel_entry(&mut state, ticket);
        }
        Ok(tickets)
    }

    pub fn cancel_read(&self, ticket: &str, owner: &str) -> Result<(), Error> {
        self.cancel_reservation(ticket, owner, false)
    }

    fn cancel_owner_reservations_in_state(
        state: &mut RegistryState,
        owner: &str,
    ) -> Vec<CancelledOperation> {
        let cancelled: Vec<_> = state
            .reads
            .iter()
            .filter(|(_, entry)| entry.owner == owner)
            .map(|(ticket, entry)| CancelledOperation {
                id: ticket.clone(),
                kind: match entry.kind {
                    ReservationKindOwned::Read => CancelledOperationKind::Read,
                    ReservationKindOwned::Analysis { .. } => CancelledOperationKind::Analysis,
                    ReservationKindOwned::Download => CancelledOperationKind::Download,
                    ReservationKindOwned::Conversion => CancelledOperationKind::Conversion,
                },
            })
            .collect();
        for operation in &cancelled {
            Self::cancel_entry(state, &operation.id);
        }
        cancelled
    }

    pub(crate) fn cancel_owner_reservations(
        &self,
        owner: &str,
    ) -> Result<Vec<CancelledOperation>, Error> {
        let mut state = self.state()?;
        Ok(Self::cancel_owner_reservations_in_state(&mut state, owner))
    }

    pub(crate) fn cancel_owner(&self, owner: &str) -> Result<Vec<CancelledOperation>, Error> {
        let mut state = self.state()?;
        let mut cancelled = Self::cancel_owner_reservations_in_state(&mut state, owner);
        let accepted: Vec<_> = state
            .accepted
            .iter()
            .filter(|(_, entry)| entry.is_download() && entry.owner == owner && !entry.committing)
            .map(|(ticket, entry)| {
                entry.cancellation.cancel();
                CancelledOperation {
                    id: ticket.clone(),
                    kind: CancelledOperationKind::Download,
                }
            })
            .collect();
        cancelled.extend(accepted);
        Ok(cancelled)
    }

    pub fn seal_and_request_cancellation(&self) -> Result<(), Error> {
        let mut state = self.state()?;
        state.sealed = true;
        state.reads.retain(|_, entry| match &entry.state {
            ReadState::Reserved { .. } | ReadState::CancelledReserved { .. } => false,
            ReadState::Active { cancellation, .. } => {
                cancellation.cancel();
                true
            }
        });
        for entry in state.accepted.values() {
            entry.cancellation.cancel();
        }
        Ok(())
    }

    /// Waits until every claimed read and accepted operation has released its native lease.
    /// Prepared reads are not work and are removed by sealing before a shutdown drain begins.
    pub fn wait_for_drain(&self, timeout: Duration) -> Result<bool, Error> {
        let deadline = Instant::now() + timeout;
        let mut state = self.state()?;
        while state
            .reads
            .values()
            .any(|entry| matches!(entry.state, ReadState::Active { .. }))
            || !state.accepted.is_empty()
        {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Ok(false);
            }
            let (next, wait) = self
                .inner
                .changed
                .wait_timeout(state, remaining)
                .map_err(|_| Error::Conflict("native operation registry poisoned".into()))?;
            state = next;
            if wait.timed_out() {
                return Ok(false);
            }
        }
        Ok(true)
    }

    #[cfg(test)]
    pub fn outstanding_labels(&self) -> Result<Vec<String>, Error> {
        let state = self.state()?;
        let mut labels: Vec<_> = state
            .reads
            .values()
            .filter_map(|entry| match &entry.state {
                ReadState::Active { label, .. } => Some(label.clone()),
                ReadState::Reserved { .. } | ReadState::CancelledReserved { .. } => None,
            })
            .chain(state.accepted.values().map(|entry| entry.label.clone()))
            .collect();
        labels.sort();
        Ok(labels)
    }

    pub fn outstanding_diagnostics(&self) -> Result<Vec<String>, Error> {
        let state = self.state()?;
        let mut diagnostics: Vec<_> = state
            .reads
            .iter()
            .filter_map(|(id, entry)| match &entry.state {
                ReadState::Active { label, .. } => Some(format!(
                    "{id} [{}] {label}",
                    if matches!(entry.kind, ReservationKindOwned::Analysis { .. }) {
                        "analysis-active"
                    } else {
                        "read-active"
                    }
                )),
                ReadState::Reserved { .. } | ReadState::CancelledReserved { .. } => None,
            })
            .chain(state.accepted.iter().map(|(id, entry)| {
                format!(
                    "{id} [{}] {}",
                    if entry.is_download() {
                        "download-accepted"
                    } else if entry.kind == Some(ReservationKindOwned::Conversion) {
                        "conversion-accepted"
                    } else {
                        "accepted-active"
                    },
                    entry.label
                )
            }))
            .collect();
        diagnostics.sort();
        Ok(diagnostics)
    }

    #[cfg(test)]
    pub(crate) fn download_admission_is_locked_for_test(&self) -> bool {
        matches!(
            self.inner.state.try_lock(),
            Err(std::sync::TryLockError::WouldBlock)
        )
    }

    #[cfg(test)]
    pub(crate) fn poison_for_test(&self) {
        let inner = Arc::clone(&self.inner);
        let _ = std::panic::catch_unwind(move || {
            let _guard = inner.state.lock().unwrap();
            panic!("poison operation registry");
        });
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum LeaseKind {
    Read,
    Accepted,
    Analysis,
}

pub struct OperationLease {
    registry: Arc<RegistryInner>,
    id: String,
    cancellation: CancellationToken,
    kind: LeaseKind,
}

#[derive(Clone)]
pub(crate) struct OperationCommitGate {
    registry: Arc<RegistryInner>,
    id: String,
}

impl OperationCommitGate {
    pub(crate) fn begin_commit(&self) -> Result<(), Error> {
        #[cfg(test)]
        COMMIT_BEFORE_HOOKS.run(&self.id);
        let result =
            (|| {
                let mut state =
                    self.registry.state.lock().map_err(|_| {
                        Error::Conflict("native operation registry poisoned".into())
                    })?;
                let entry = state.accepted.get_mut(&self.id).ok_or_else(|| {
                    Error::Conflict("download operation is no longer active".into())
                })?;
                if !entry.is_download() {
                    return Err(Error::Conflict("native operation is not a download".into()));
                }
                if entry.cancellation.is_cancelled() {
                    return Err(Error::Cancellation);
                }
                entry.committing = true;
                Ok(())
            })();
        #[cfg(test)]
        if result.is_ok() {
            COMMIT_AFTER_HOOKS.run(&self.id);
        }
        result
    }
}

#[cfg(test)]
pub(crate) fn arm_commit_before_hook(id: String, hook: crate::infra::test_hooks::TestHook) {
    COMMIT_BEFORE_HOOKS.arm(id, hook);
}

#[cfg(test)]
pub(crate) fn arm_commit_after_hook(id: String, hook: crate::infra::test_hooks::TestHook) {
    COMMIT_AFTER_HOOKS.arm(id, hook);
}

impl OperationLease {
    pub fn token(&self) -> CancellationToken {
        self.cancellation.clone()
    }

    pub(crate) fn commit_gate(&self) -> OperationCommitGate {
        OperationCommitGate {
            registry: Arc::clone(&self.registry),
            id: self.id.clone(),
        }
    }

    fn kind(&self) -> LeaseKind {
        self.kind
    }
}

/// Runs a complete operation workflow under native ownership. The command future only receives
/// the terminal value; dropping it cannot drop the workflow, its worker await, or an async tail.
/// Dropping a transient read's command future cancels that exact request, while accepted work
/// remains completion-owned. Terminal failures are observed before result delivery and lease
/// release, so a dropped or buffered receiver cannot detach an unobserved error.
pub async fn run_native_operation<T, F>(
    lease: OperationLease,
    label: &'static str,
    workflow: F,
) -> Result<T, Error>
where
    T: Send + 'static,
    F: Future<Output = Result<T, Error>> + Send + 'static,
{
    let (result_tx, result_rx) = tokio::sync::oneshot::channel();
    let operation_id = lease.id.clone();
    let awaiter_guard = (lease.kind() == LeaseKind::Read).then(|| lease.token().drop_guard());
    tokio::spawn(async move {
        let result = match std::panic::AssertUnwindSafe(workflow).catch_unwind().await {
            Ok(result) => result,
            Err(_) => Err(Error::Conflict(format!(
                "native operation panicked ({label})"
            ))),
        };
        if let Err(error) = &result {
            if matches!(error, Error::Cancellation | Error::AnalysisCancelled) {
                log::debug!("native operation cancelled id={operation_id} label={label}");
            } else {
                log::error!(
                    "native operation failed id={operation_id} label={label}: {}",
                    error.diagnostic()
                );
            }
        }
        // The workflow, including all async cleanup, is complete before its lease is released.
        drop(lease);
        let _ = result_tx.send(result);
    });

    let result = result_rx
        .await
        .map_err(|_| Error::Conflict("native operation result channel closed".into()))?;
    if let Some(awaiter_guard) = awaiter_guard {
        let _ = awaiter_guard.disarm();
    }
    result
}

/// Starts one application attempt whose result every replacement document can join. Publish its
/// immutable outcome only after native drain ownership ends, before acknowledgement may begin.
pub(crate) fn run_completion_application<F>(
    lease: OperationLease,
    result: tokio::sync::oneshot::Sender<Result<(), Arc<Error>>>,
    label: &'static str,
    workflow: F,
) where
    F: Future<Output = Result<(), Error>> + Send + 'static,
{
    tokio::spawn(async move {
        let outcome = run_native_operation(lease, label, workflow)
            .await
            .map_err(Arc::new);
        let _ = result.send(outcome);
    });
}

/// Completion-owns one admitted blocking workflow. Call this only at an outer command boundary;
/// the closure must not acquire the blocking gateway again.
pub async fn run_accepted_blocking<T, F>(
    registry: &OperationRegistry,
    label: &'static str,
    workflow: F,
) -> Result<T, Error>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, Error> + Send + 'static,
{
    let lease = registry.accept(label)?;
    run_native_operation(lease, label, async move {
        crate::infra::blocking::BLOCKING_GATEWAY
            .spawn(workflow)
            .await
    })
    .await
}

impl Drop for OperationLease {
    fn drop(&mut self) {
        let mut state = match self.registry.state.lock() {
            Ok(state) => state,
            Err(poisoned) => poisoned.into_inner(),
        };
        match self.kind {
            LeaseKind::Read => {
                state.reads.remove(&self.id);
            }
            LeaseKind::Accepted => {
                state.accepted.remove(&self.id);
            }
            LeaseKind::Analysis => {
                state.reads.remove(&self.id);
            }
        }
        self.registry.changed.notify_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn conversion_reservations_validate_owner_kind_and_remember_cancellation() {
        let registry = OperationRegistry::default();
        let ticket = registry.prepare_conversion("first").unwrap();
        assert!(registry.claim_conversion(&ticket, "other").is_err());
        assert!(registry.cancel_conversion(&ticket, "other").is_err());
        assert!(registry.release_conversion(&ticket, "other").is_err());
        assert!(registry.cancel_download(&ticket, "first").is_err());
        assert!(registry.release_download(&ticket, "first").is_err());
        assert!(registry.cancel_conversion(&ticket, "first").unwrap());
        assert!(registry.cancel_conversion(&ticket, "first").unwrap());
        assert!(matches!(
            registry.claim_conversion(&ticket, "first"),
            Err(Error::Cancellation)
        ));
        assert!(!registry.cancel_conversion(&ticket, "first").unwrap());
        let download = registry.prepare_download("first").unwrap();
        assert!(registry.claim_conversion(&download, "first").is_err());
        assert!(registry.cancel_conversion(&download, "first").is_err());
        assert!(registry.release_conversion(&download, "first").is_err());
        let read = registry.prepare_read("first").unwrap();
        assert!(registry.claim_conversion(&read, "first").is_err());
        registry.release_download(&download, "first").unwrap();
        registry.cancel_read(&read, "first").unwrap();
    }

    #[test]
    fn conversion_active_release_preserves_worker_and_only_exact_ticket_cancels() {
        let registry = OperationRegistry::default();
        let first = registry.prepare_conversion("first").unwrap();
        let sibling = registry.prepare_conversion("first").unwrap();
        let lease = registry.claim_conversion(&first, "first").unwrap();
        let other = registry.claim_conversion(&sibling, "first").unwrap();
        assert!(registry.cancel_conversion(&first, "other").is_err());
        assert!(registry.release_conversion(&first, "other").is_err());
        assert!(registry.cancel_download(&first, "first").is_err());
        assert!(registry.release_download(&first, "first").is_err());
        registry.release_conversion(&first, "first").unwrap();
        assert_eq!(registry.outstanding_labels().unwrap().len(), 2);
        registry.cancel_owner_reservations("first").unwrap();
        registry.cancel_owner("first").unwrap();
        assert!(!lease.token().is_cancelled());
        assert!(registry.cancel_conversion(&first, "first").unwrap());
        assert!(lease.token().is_cancelled());
        assert!(!other.token().is_cancelled());
        drop(lease);
        assert!(!registry.cancel_conversion(&first, "first").unwrap());
        registry.seal_and_request_cancellation().unwrap();
        assert!(other.token().is_cancelled());
        assert!(!registry.wait_for_drain(Duration::ZERO).unwrap());
        drop(other);
        assert!(registry.wait_for_drain(Duration::ZERO).unwrap());
    }

    #[test]
    fn conversion_reservations_expire_and_share_bounded_capacity_without_download_policy() {
        let expired = OperationRegistry::with_reservation_ttl(Duration::ZERO);
        let ticket = expired.prepare_conversion("main").unwrap();
        assert!(expired.claim_conversion(&ticket, "main").is_err());
        assert!(!expired.cancel_conversion(&ticket, "main").unwrap());
        let registry = OperationRegistry::default();
        let tickets: Vec<_> = (0..MAX_NATIVE_READS)
            .map(|_| registry.prepare_conversion("main").unwrap())
            .collect();
        assert!(matches!(
            registry.prepare_conversion("main"),
            Err(Error::ResourceLimit(_))
        ));
        let leases: Vec<_> = tickets
            .iter()
            .map(|ticket| registry.claim_conversion(ticket, "main").unwrap())
            .collect();
        let excess = registry.prepare_conversion("main").unwrap();
        assert!(matches!(
            registry.claim_conversion(&excess, "main"),
            Err(Error::ResourceLimit(_))
        ));
        registry.release_conversion(&excess, "main").unwrap();
        assert!(!registry.cancel_conversion(&excess, "main").unwrap());
        drop(leases);
        assert!(registry.accept("recovered").is_ok());
    }

    #[tokio::test]
    async fn import_failure_operations_log_preserves_source_chain() {
        #[derive(Debug, thiserror::Error)]
        #[error("operation source failure")]
        struct SourceFailure(#[source] std::io::Error);

        // The current-thread runtime lets the existing thread-local capture see the task log.
        let capture = crate::error::LogCaptureScope::start();
        let registry = OperationRegistry::default();
        let lease = registry.accept("import-failure-chain").unwrap();
        let error = run_native_operation::<(), _>(lease, "import-failure-chain", async {
            Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                SourceFailure(std::io::Error::other("operation root cause")),
            )
            .into())
        })
        .await
        .unwrap_err();
        let messages = capture.messages();
        assert_eq!(messages.len(), 1, "{messages:?}");
        assert!(messages[0].contains("native operation failed id="));
        assert!(messages[0].contains("label=import-failure-chain: I/O failure:"));
        assert!(messages[0].contains("operation source failure"));
        assert!(messages[0].contains("operation root cause"));
        assert_eq!(
            serde_json::to_value(&error).unwrap()["message"],
            "I/O failure"
        );
        assert!(registry.outstanding_diagnostics().unwrap().is_empty());
    }

    #[test]
    fn reservations_are_owner_bound_single_use_and_late_cancel_is_safe() {
        let registry = OperationRegistry::default();
        let ticket = registry.prepare_read("first").unwrap();
        assert!(registry.claim_read(&ticket, "second", "read").is_err());
        let lease = registry.claim_read(&ticket, "first", "read").unwrap();
        assert!(registry.claim_read(&ticket, "first", "read").is_err());
        drop(lease);
        registry.cancel_read(&ticket, "first").unwrap();
    }

    #[test]
    fn cancelling_an_active_read_reaches_its_token() {
        let registry = OperationRegistry::default();
        let ticket = registry.prepare_read("main").unwrap();
        let lease = registry.claim_read(&ticket, "main", "query").unwrap();
        registry.cancel_read(&ticket, "main").unwrap();
        assert!(lease.token().is_cancelled());
    }

    #[test]
    fn progress_lookup_is_owner_isolated_and_cancels_only_the_matching_download() {
        let registry = OperationRegistry::default();
        let other_ticket = registry.prepare_download("other").unwrap();
        let other = registry
            .claim_download(
                &other_ticket,
                "other",
                "download",
                "shared",
                "shared",
                false,
                8,
            )
            .unwrap();
        assert!(!registry
            .cancel_download_for_progress("shared", "main")
            .unwrap());
        assert!(!other.token().is_cancelled());
        let ticket = registry.prepare_download("main").unwrap();
        let download = registry
            .claim_download(&ticket, "main", "download", "shared", "shared", false, 8)
            .unwrap();
        let unrelated_ticket = registry.prepare_download("main").unwrap();
        let unrelated = registry
            .claim_download(
                &unrelated_ticket,
                "main",
                "download",
                "different",
                "different",
                false,
                8,
            )
            .unwrap();
        let accepted = registry.accept("ownerless accepted").unwrap();

        assert!(!registry
            .cancel_download_for_progress("missing", "main")
            .unwrap());
        assert!(registry
            .cancel_download_for_progress("shared", "main")
            .unwrap());
        assert!(download.token().is_cancelled());
        assert!(!other.token().is_cancelled());
        assert!(!unrelated.token().is_cancelled());
        assert!(!accepted.token().is_cancelled());
        assert!(matches!(
            download.commit_gate().begin_commit(),
            Err(Error::Cancellation)
        ));
    }

    #[test]
    fn duplicate_uncancelled_progress_claim_respects_exclusive_admission_across_owners(
    ) -> Result<(), Error> {
        let registry = OperationRegistry::default();
        let first_ticket = registry.prepare_download("first").unwrap();
        let first = registry
            .claim_download(
                &first_ticket,
                "first",
                "first",
                "first-progress",
                "shared",
                false,
                8,
            )
            .unwrap();
        let second_ticket = registry.prepare_download("second").unwrap();
        let second = registry
            .claim_download(
                &second_ticket,
                "second",
                "second",
                "second-progress",
                "shared",
                false,
                8,
            )
            .unwrap();
        let duplicate = registry.prepare_download("first").unwrap();
        assert!(
            matches!(registry.claim_download(&duplicate, "first", "duplicate", "different-progress", "shared", false, 8), Err(Error::Conflict(message)) if message == "download progress is already active")
        );
        let exclusive = registry.prepare_download("third").unwrap();
        assert!(
            matches!(registry.claim_download(&exclusive, "third", "exclusive", "exclusive-progress", "shared", true, 8), Err(Error::Conflict(message)) if message == "download progress is already active")
        );
        assert_eq!(registry.state().unwrap().accepted.len(), 2);
        assert_eq!(
            registry
                .state()
                .unwrap()
                .accepted
                .get(&first_ticket)
                .unwrap()
                .progress_id
                .as_deref(),
            Some("first-progress")
        );
        drop(first);
        drop(second);
        let active = registry
            .claim_download(
                &exclusive,
                "third",
                "exclusive",
                "exclusive-progress",
                "shared",
                true,
                8,
            )
            .unwrap();
        let fifth_ticket = registry.prepare_download("fifth")?;
        let fifth = registry.claim_download(
            &fifth_ticket,
            "fifth",
            "fifth",
            "fifth-progress",
            "other-account",
            true,
            8,
        );
        assert!(
            fifth.is_ok(),
            "exclusive other-account claim must be admitted"
        );
        let fifth = fifth?;
        assert_eq!(registry.state()?.accepted.len(), 2);
        drop(fifth);
        let other_ticket = registry.prepare_download("fourth").unwrap();
        assert!(
            matches!(registry.claim_download(&other_ticket, "fourth", "other", "other-progress", "shared", true, 8), Err(Error::Conflict(message)) if message == "download progress is already active")
        );
        assert!(registry.cancel_download_for_progress("exclusive-progress", "third")?);
        assert!(active.token().is_cancelled());
        let sixth_ticket = registry.prepare_download("sixth")?;
        let sixth = registry.claim_download(
            &sixth_ticket,
            "sixth",
            "sixth",
            "sixth-progress",
            "shared",
            true,
            8,
        );
        assert!(
            sixth.is_ok(),
            "exclusive shared claim after cancel must be admitted"
        );
        let sixth = sixth?;
        drop(sixth);
        drop(active);
        assert!(registry
            .claim_download(
                &other_ticket,
                "fourth",
                "other",
                "other-progress",
                "shared",
                true,
                8
            )
            .is_ok());
        Ok(())
    }

    #[test]
    fn duplicate_uncancelled_progress_claim_keeps_the_ticket_reserved_without_a_lease() {
        let registry = OperationRegistry::default();
        let ticket = registry.prepare_download("main").unwrap();
        let download = registry
            .claim_download(&ticket, "main", "first", "progress", "progress", false, 8)
            .unwrap();
        let duplicate = registry.prepare_download("main").unwrap();
        assert!(matches!(
            registry.claim_download(
                &duplicate,
                "main",
                "duplicate",
                "progress",
                "progress",
                false,
                8
            ),
            Err(Error::Conflict(_))
        ));
        {
            let state = registry.state().unwrap();
            assert_eq!(state.accepted.len(), 1);
            assert!(!state.accepted.contains_key(&duplicate));
            assert!(matches!(
                state.reads.get(&duplicate).unwrap().state,
                ReadState::Reserved { .. }
            ));
        }
        registry.release_download(&duplicate, "main").unwrap();
        assert!(!registry.state().unwrap().reads.contains_key(&duplicate));
        assert!(!download.token().is_cancelled());
    }

    #[test]
    fn cancelled_download_does_not_block_retry_and_lookup_selects_the_uncancelled_one() {
        let registry = OperationRegistry::default();
        let ticket = registry.prepare_download("main").unwrap();
        let first = registry
            .claim_download(&ticket, "main", "first", "progress", "progress", false, 8)
            .unwrap();
        assert!(registry.cancel_download(&ticket, "main").unwrap());
        assert!(registry
            .cancel_download_for_progress("progress", "main")
            .unwrap());
        assert_eq!(registry.outstanding_labels().unwrap(), vec!["first"]);
        assert!(!registry
            .with_live_download_for_progress("progress", |live| live)
            .unwrap());
        let retry_ticket = registry.prepare_download("main").unwrap();
        let retry = registry
            .claim_download(
                &retry_ticket,
                "main",
                "retry",
                "progress",
                "progress",
                false,
                8,
            )
            .unwrap();
        assert!(registry
            .with_live_download_for_progress("progress", |live| live)
            .unwrap());
        assert!(registry
            .cancel_download_for_progress("progress", "main")
            .unwrap());
        assert!(retry.token().is_cancelled());
        assert!(first.token().is_cancelled());
        assert!(matches!(
            retry.commit_gate().begin_commit(),
            Err(Error::Cancellation)
        ));
        assert!(registry
            .cancel_download_for_progress("progress", "main")
            .unwrap());
        drop(first);
        drop(retry);
        assert!(!registry
            .cancel_download_for_progress("progress", "main")
            .unwrap());
    }

    #[test]
    fn progress_lookup_does_not_cancel_a_committing_retry_even_with_a_cancelled_match() {
        let registry = OperationRegistry::default();
        let first_ticket = registry.prepare_download("main").unwrap();
        let first = registry
            .claim_download(
                &first_ticket,
                "main",
                "first",
                "progress",
                "progress",
                false,
                8,
            )
            .unwrap();
        first.token().cancel();
        let ticket = registry.prepare_download("main").unwrap();
        let committing = registry
            .claim_download(
                &ticket,
                "main",
                "committing",
                "progress",
                "progress",
                false,
                8,
            )
            .unwrap();
        committing.commit_gate().begin_commit().unwrap();
        assert!(!registry
            .cancel_download_for_progress("progress", "main")
            .unwrap());
        assert!(!committing.token().is_cancelled());
        assert!(registry
            .with_live_download_for_progress("progress", |live| live)
            .unwrap());
        let duplicate = registry.prepare_download("main").unwrap();
        assert!(matches!(
            registry.claim_download(
                &duplicate,
                "main",
                "duplicate",
                "progress",
                "progress",
                false,
                8
            ),
            Err(Error::Conflict(_))
        ));
    }

    #[test]
    fn progress_lookup_and_live_check_return_typed_registry_failures() {
        let registry = OperationRegistry::default();
        registry.poison_for_test();
        assert!(matches!(
            registry.cancel_download_for_progress("progress", "main"),
            Err(Error::Conflict(_))
        ));
        assert!(matches!(
            registry.with_live_download_for_progress("progress", |_| panic!(
                "registry failure must not decide a clear"
            )),
            Err(Error::Conflict(_))
        ));
    }

    #[test]
    fn download_reservations_are_cancelled_before_claim_and_owner_bound() {
        let registry = OperationRegistry::default();
        let ticket = registry.prepare_download("first").unwrap();
        assert!(matches!(
            registry.cancel_download(&ticket, "second"),
            Err(Error::Conflict(_))
        ));
        assert!(registry.cancel_download(&ticket, "first").unwrap());
        assert!(registry.cancel_download(&ticket, "first").unwrap());
        assert!(matches!(
            registry.claim_download(&ticket, "first", "download", "progress", "progress", false, 1),
            Err(Error::Cancellation)
        ));
        assert!(!registry.cancel_download(&ticket, "first").unwrap());
    }

    #[test]
    fn download_reservations_reject_kind_confusion_and_release_cleanly() {
        let registry = OperationRegistry::default();
        let read = registry.prepare_read("owner").unwrap();
        assert!(matches!(
            registry.cancel_download(&read, "owner"),
            Err(Error::Conflict(_))
        ));
        assert!(matches!(
            registry.claim_download(&read, "owner", "download", "progress", "progress", false, 1),
            Err(Error::Conflict(_))
        ));
        registry.cancel_read(&read, "owner").unwrap();

        let download = registry.prepare_download("owner").unwrap();
        assert!(matches!(
            registry.cancel_read(&download, "owner"),
            Err(Error::Conflict(_))
        ));
        registry.release_download(&download, "owner").unwrap();
        assert!(!registry.cancel_download(&download, "owner").unwrap());
    }

    #[test]
    fn analysis_reservations_bind_owner_and_tab_and_cancel_before_claim() {
        let registry = OperationRegistry::default();
        let wrong_owner = registry.prepare_analysis("first", "tab-a").unwrap();
        assert!(registry
            .claim_analysis(&wrong_owner, "second", "tab-a", "analysis")
            .is_err());
        assert!(registry
            .claim_analysis(&wrong_owner, "first", "tab-b", "analysis")
            .is_err());

        registry.cancel_analysis(&wrong_owner, "first").unwrap();
        assert!(registry
            .claim_analysis(&wrong_owner, "first", "tab-a", "analysis")
            .is_err());

        let active_id = registry.prepare_analysis("first", "tab-a").unwrap();
        let active = registry
            .claim_analysis(&active_id, "first", "tab-a", "analysis")
            .unwrap();
        assert!(registry
            .outstanding_diagnostics()
            .unwrap()
            .contains(&format!("{active_id} [analysis-active] analysis")));
        assert!(registry
            .claim_analysis(&active_id, "first", "tab-a", "analysis")
            .is_err());
        let other_id = registry.prepare_analysis("first", "tab-b").unwrap();
        let other = registry
            .claim_analysis(&other_id, "first", "tab-b", "analysis")
            .unwrap();
        let other_owner_id = registry.prepare_analysis("second", "tab-a").unwrap();
        let other_owner = registry
            .claim_analysis(&other_owner_id, "second", "tab-a", "analysis")
            .unwrap();

        assert_eq!(
            registry.cancel_analyses_for_tab("first", "tab-a").unwrap(),
            vec![active_id]
        );
        assert!(active.token().is_cancelled());
        assert!(!other.token().is_cancelled());
        assert!(!other_owner.token().is_cancelled());
    }

    #[test]
    fn downloads_share_accepted_capacity_and_keep_their_narrower_cap() {
        let registry = OperationRegistry::default();
        let tickets: Vec<_> = (0..32)
            .map(|index| {
                registry
                    .prepare_download(&format!("owner-{index}"))
                    .unwrap()
            })
            .collect();
        let downloads: Vec<_> = tickets
            .iter()
            .enumerate()
            .map(|(index, _)| {
                registry
                    .claim_download(
                        &tickets[index],
                        &format!("owner-{index}"),
                        "download",
                        "progress",
                        "progress",
                        false,
                        32,
                    )
                    .unwrap()
            })
            .collect();
        let excess = registry.prepare_download("excess").unwrap();
        assert!(matches!(
            registry
                .claim_download(&excess, "excess", "download", "progress", "progress", false, 32),
            Err(Error::ResourceLimit(_))
        ));
        let accepted: Vec<_> = (downloads.len()..MAX_ACCEPTED_OPERATIONS)
            .map(|_| registry.accept("accepted").unwrap())
            .collect();
        assert!(matches!(
            registry.accept("excess"),
            Err(Error::ResourceLimit(_))
        ));

        assert!(registry.cancel_download(&tickets[0], "owner-0").unwrap());
        assert!(downloads[0].token().is_cancelled());
        assert!(registry
            .outstanding_diagnostics()
            .unwrap()
            .contains(&format!("{} [download-accepted] download", tickets[0])));
        assert!(!downloads[1].token().is_cancelled());
        drop(downloads);
        drop(accepted);
        let recovered = registry.prepare_download("recovered").unwrap();
        assert!(registry
            .claim_download(
                &recovered,
                "recovered",
                "download",
                "progress",
                "progress",
                false,
                32
            )
            .is_ok());
    }

    #[test]
    fn previous_document_sweep_cancels_only_the_owners_reservations() {
        let registry = OperationRegistry::default();
        let read = registry.prepare_read("main").unwrap();
        let read_lease = registry.claim_read(&read, "main", "read").unwrap();
        let reserved_read = registry.prepare_read("main").unwrap();
        let analysis = registry.prepare_analysis("main", "tab").unwrap();
        let analysis_lease = registry
            .claim_analysis(&analysis, "main", "tab", "analysis")
            .unwrap();
        let reserved_analysis = registry.prepare_analysis("main", "background").unwrap();
        let download = registry.prepare_download("main").unwrap();
        let cancelled_download = registry.prepare_download("main").unwrap();
        registry
            .cancel_download(&cancelled_download, "main")
            .unwrap();
        let accepted_download = registry.prepare_download("main").unwrap();
        let download_lease = registry
            .claim_download(
                &accepted_download,
                "main",
                "download",
                "progress",
                "progress",
                false,
                8,
            )
            .unwrap();
        let accepted = registry.accept("ownerless work").unwrap();
        let other_read = registry.prepare_read("other").unwrap();
        let other_read_lease = registry
            .claim_read(&other_read, "other", "other read")
            .unwrap();
        let other_analysis = registry.prepare_analysis("other", "tab").unwrap();
        let other_analysis_lease = registry
            .claim_analysis(&other_analysis, "other", "tab", "other analysis")
            .unwrap();
        let other_download = registry.prepare_download("other").unwrap();
        let other_accepted_download = registry.prepare_download("other").unwrap();
        let other_download_lease = registry
            .claim_download(
                &other_accepted_download,
                "other",
                "other download",
                "progress",
                "progress",
                false,
                8,
            )
            .unwrap();

        let cancelled = registry.cancel_owner_reservations("main").unwrap();
        assert_eq!(cancelled.len(), 6);
        for (id, kind) in [
            (&read, CancelledOperationKind::Read),
            (&reserved_read, CancelledOperationKind::Read),
            (&analysis, CancelledOperationKind::Analysis),
            (&reserved_analysis, CancelledOperationKind::Analysis),
            (&download, CancelledOperationKind::Download),
            (&cancelled_download, CancelledOperationKind::Download),
        ] {
            assert!(cancelled
                .iter()
                .any(|entry| &entry.id == id && entry.kind == kind));
        }
        assert!(read_lease.token().is_cancelled());
        assert!(analysis_lease.token().is_cancelled());
        let state = registry.state().unwrap();
        for id in [
            &reserved_read,
            &reserved_analysis,
            &download,
            &cancelled_download,
        ] {
            assert!(!state.reads.contains_key(id));
        }
        assert!(state.reads.contains_key(&read));
        assert!(state.reads.contains_key(&analysis));
        assert!(state.reads.contains_key(&other_download));
        drop(state);
        for lease in [
            &download_lease,
            &accepted,
            &other_read_lease,
            &other_analysis_lease,
            &other_download_lease,
        ] {
            assert!(!lease.token().is_cancelled());
        }
        drop(read_lease);
        drop(analysis_lease);
        assert!(registry
            .cancel_owner_reservations("main")
            .unwrap()
            .is_empty());
    }

    #[test]
    fn owner_destruction_cancels_reservations_and_non_committing_downloads() {
        let registry = OperationRegistry::default();
        let read = registry.prepare_read("main").unwrap();
        let read_lease = registry.claim_read(&read, "main", "read").unwrap();
        let analysis = registry.prepare_analysis("main", "tab").unwrap();
        let analysis_lease = registry
            .claim_analysis(&analysis, "main", "tab", "analysis")
            .unwrap();
        let reserved = registry.prepare_download("main").unwrap();
        let download = registry.prepare_download("main").unwrap();
        let download_lease = registry
            .claim_download(
                &download, "main", "download", "progress", "progress", false, 8,
            )
            .unwrap();
        let committing = registry.prepare_download("main").unwrap();
        let committing_lease = registry
            .claim_download(
                &committing,
                "main",
                "committing",
                "committing",
                "committing",
                false,
                8,
            )
            .unwrap();
        committing_lease.commit_gate().begin_commit().unwrap();
        let cancelled = registry.cancel_owner("main").unwrap();
        assert_eq!(cancelled.len(), 4);
        for id in [&read, &analysis, &reserved, &download] {
            assert!(cancelled.iter().any(|entry| &entry.id == id));
        }
        assert!(cancelled
            .iter()
            .any(|entry| entry.id == analysis && entry.kind == CancelledOperationKind::Analysis));
        assert!(read_lease.token().is_cancelled());
        assert!(analysis_lease.token().is_cancelled());
        assert!(download_lease.token().is_cancelled());
        assert!(!committing_lease.token().is_cancelled());
        assert!(!registry.state().unwrap().reads.contains_key(&reserved));
    }

    #[test]
    fn owner_destruction_does_not_cancel_another_owner_or_accepted_work() {
        let registry = OperationRegistry::default();
        let first = registry.prepare_read("first").unwrap();
        let second = registry.prepare_read("second").unwrap();
        let first_lease = registry.claim_read(&first, "first", "first read").unwrap();
        let second_lease = registry
            .claim_read(&second, "second", "second read")
            .unwrap();
        let accepted = registry.accept("accepted").unwrap();
        assert_eq!(
            registry.cancel_owner("first").unwrap(),
            vec![CancelledOperation {
                id: first,
                kind: CancelledOperationKind::Read,
            }]
        );
        assert!(first_lease.token().is_cancelled());
        assert!(!second_lease.token().is_cancelled());
        assert!(!accepted.token().is_cancelled());
    }

    #[test]
    fn capacity_returns_when_leases_drop() {
        let registry = OperationRegistry::default();
        let leases: Vec<_> = (0..MAX_ACCEPTED_OPERATIONS)
            .map(|_| registry.accept("held").unwrap())
            .collect();
        assert!(matches!(
            registry.accept("excess"),
            Err(Error::ResourceLimit(_))
        ));
        drop(leases);
        assert!(registry.accept("recovered").is_ok());
    }

    #[test]
    fn expired_reservations_release_read_capacity() {
        let registry = OperationRegistry::with_reservation_ttl(Duration::ZERO);
        for _ in 0..MAX_NATIVE_READS + 1 {
            registry.prepare_read("main").unwrap();
        }
        let ticket = registry.prepare_read("main").unwrap();
        assert!(registry.claim_read(&ticket, "main", "expired").is_err());
    }

    #[test]
    fn sealing_rejects_new_work_and_cancels_active_reads() {
        let registry = OperationRegistry::default();
        let ticket = registry.prepare_read("main").unwrap();
        let lease = registry.claim_read(&ticket, "main", "held").unwrap();
        registry.seal_and_request_cancellation().unwrap();
        assert!(lease.token().is_cancelled());
        assert!(registry.prepare_read("main").is_err());
        assert!(registry.accept("accepted").is_err());
    }

    #[test]
    fn lease_drop_recovers_poison_and_restores_capacity() {
        let registry = OperationRegistry::default();
        let lease = registry.accept("held").unwrap();
        let inner = Arc::clone(&registry.inner);
        let panicked = std::panic::catch_unwind(move || {
            let _guard = inner.state.lock().unwrap();
            panic!("poison registry");
        });
        assert!(panicked.is_err());
        drop(lease);
        assert!(matches!(
            registry.accept("after cleanup"),
            Err(Error::Conflict(_))
        ));
        match registry.inner.state.lock() {
            Err(poisoned) => assert!(poisoned.into_inner().accepted.is_empty()),
            Ok(_) => panic!("registry poison must remain visible"),
        };
    }

    #[test]
    fn active_and_prepared_reads_share_the_capacity_bound() {
        let registry = OperationRegistry::default();
        let active_ticket = registry.prepare_read("main").unwrap();
        let active = registry
            .claim_read(&active_ticket, "main", "active")
            .unwrap();
        let prepared: Vec<_> = (1..MAX_NATIVE_READS)
            .map(|_| registry.prepare_read("main").unwrap())
            .collect();
        assert!(matches!(
            registry.prepare_read("main"),
            Err(Error::ResourceLimit(_))
        ));
        drop(active);
        assert!(registry.prepare_read("main").is_ok());
        assert_eq!(prepared.len(), MAX_NATIVE_READS - 1);
    }

    #[test]
    fn drain_waits_for_claimed_and_accepted_leases() {
        let registry = OperationRegistry::default();
        let ticket = registry.prepare_read("main").unwrap();
        let read = registry.claim_read(&ticket, "main", "read").unwrap();
        let accepted = registry.accept("accepted").unwrap();
        registry.seal_and_request_cancellation().unwrap();
        assert!(!registry.wait_for_drain(Duration::from_millis(1)).unwrap());
        drop(read);
        assert!(!registry.wait_for_drain(Duration::from_millis(1)).unwrap());
        drop(accepted);
        assert!(registry.wait_for_drain(Duration::from_millis(20)).unwrap());
    }

    #[tokio::test]
    async fn accepted_workflow_survives_awaiting_caller_drop_and_async_tail() {
        let registry = OperationRegistry::default();
        let lease = registry.accept("held workflow").unwrap();
        let token = lease.token();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(run_native_operation(lease, "held workflow", async move {
            let _ = release_rx.await;
            Ok::<_, Error>(())
        }));
        tokio::task::yield_now().await;
        task.abort();
        assert!(!token.is_cancelled());
        assert_eq!(
            registry.outstanding_labels().unwrap(),
            vec!["held workflow"]
        );
        release_tx.send(()).unwrap();
        assert!(tokio::time::timeout(Duration::from_secs(1), async {
            while !registry.outstanding_labels().unwrap().is_empty() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .is_ok());
    }

    #[tokio::test]
    async fn transient_caller_drop_cancels_worker_but_keeps_lease_through_async_tail() {
        let registry = OperationRegistry::default();
        let ticket = registry.prepare_read("main").unwrap();
        let lease = registry.claim_read(&ticket, "main", "held read").unwrap();
        let token = lease.token();
        let worker_token = token.clone();
        let (worker_exited_tx, worker_exited_rx) = tokio::sync::oneshot::channel();
        let (tail_release_tx, tail_release_rx) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(run_native_operation(lease, "held read", async move {
            worker_token.cancelled().await;
            let _ = worker_exited_tx.send(());
            let _ = tail_release_rx.await;
            Err::<(), _>(Error::Cancellation)
        }));
        tokio::task::yield_now().await;
        task.abort();
        tokio::time::timeout(Duration::from_secs(1), worker_exited_rx)
            .await
            .unwrap()
            .unwrap();
        assert!(token.is_cancelled());
        assert_eq!(registry.outstanding_labels().unwrap(), vec!["held read"]);
        tail_release_tx.send(()).unwrap();
        assert!(tokio::time::timeout(Duration::from_secs(1), async {
            while !registry.outstanding_labels().unwrap().is_empty() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .is_ok());
    }

    #[tokio::test]
    async fn dropping_receiver_before_delivery_does_not_detach_failure_or_lease() {
        let registry = OperationRegistry::default();
        let lease = registry.accept("failure before delivery").unwrap();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(run_native_operation(
            lease,
            "failure before delivery",
            async move {
                let _ = release_rx.await;
                Err::<(), _>(Error::Conflict("expected failure".into()))
            },
        ));
        tokio::task::yield_now().await;
        task.abort();
        release_tx.send(()).unwrap();
        assert!(tokio::time::timeout(Duration::from_secs(1), async {
            while !registry.outstanding_labels().unwrap().is_empty() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .is_ok());
    }

    #[tokio::test]
    async fn dropping_receiver_after_result_is_buffered_leaves_no_observer_or_lease() {
        let registry = OperationRegistry::default();
        let lease = registry.accept("buffered failure").unwrap();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        let mut operation = Box::pin(run_native_operation(
            lease,
            "buffered failure",
            async move {
                let _ = release_rx.await;
                Err::<(), _>(Error::Conflict("expected buffered failure".into()))
            },
        ));
        assert!(futures_util::poll!(&mut operation).is_pending());
        release_tx.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(1), async {
            while !registry.outstanding_labels().unwrap().is_empty() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        drop(operation);
        assert!(registry.wait_for_drain(Duration::ZERO).unwrap());
    }
}
