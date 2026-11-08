use serde::{Deserialize, Serialize};
use shakmaty::Chess;
use specta::Type;

pub(crate) const DATABASE_SCHEMA_NOT_CURRENT: &str = "database schema upgrade is required";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Type)]
pub enum DurabilityStage {
    ArchiveCommitMarker,
    ArchiveReservationJournal,
    DatabasePgnReplacement,
    DirectoryInstall,
    DownloadTargetReplacement,
    NativeExport,
    OldDirectoryCleanup,
    OldDirectoryCleanupSync,
    PgnEdit,
    PgnCacheInvalidation,
    CollectionIndexRefresh,
    PgnCapabilityRebind,
    RegistryReplacement,
    SearchIndexReplacement,
    WorkspaceDirectoryCreation,
    WorkspacePgnCreation,
    WorkspaceRemoval,
    WorkspaceRename,
    WorkspaceSidecarCreation,
    WorkspaceSidecarReplacement,
    PracticePositions,
    PracticeReviewShard,
    PracticeState,
}

impl std::fmt::Display for DurabilityStage {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::ArchiveCommitMarker => {
                "artifact commit marker, which may have committed; do not retry"
            }
            Self::ArchiveReservationJournal => {
                "artifact reservation journal, which may have committed; do not install or retry"
            }
            Self::DatabasePgnReplacement => "database PGN replacement",
            Self::DirectoryInstall => "directory installation",
            Self::DownloadTargetReplacement => "download target replacement",
            Self::NativeExport => "native export",
            Self::OldDirectoryCleanup => "old directory cleanup",
            Self::OldDirectoryCleanupSync => "old directory cleanup sync",
            Self::PgnEdit => "PGN edit",
            Self::PgnCacheInvalidation => "PGN cache invalidation after a committed edit",
            Self::CollectionIndexRefresh => "collection index refresh after a committed PGN edit",
            Self::PgnCapabilityRebind => "PGN file capability rebind after a committed edit",
            Self::RegistryReplacement => "registry replacement",
            Self::SearchIndexReplacement => "search index replacement",
            Self::WorkspaceDirectoryCreation => "workspace directory creation",
            Self::WorkspacePgnCreation => "workspace PGN creation",
            Self::WorkspaceRemoval => "workspace removal",
            Self::WorkspaceRename => "workspace rename",
            Self::WorkspaceSidecarCreation => "workspace sidecar creation",
            Self::WorkspaceSidecarReplacement => "workspace sidecar replacement",
            Self::PracticePositions => "practice positions replacement",
            Self::PracticeReviewShard => "practice review-shard replacement",
            Self::PracticeState => "practice migration-state replacement",
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum ErrorCategory {
    Io,
    Parsing,
    Platform,
    Network,
    ChessData,
    Database,
    InvalidInput,
    StaleGame,
    MissingResource,
    Conflict,
    ResourceLimit,
    Authentication,
    Credential,
    Cancellation,
    Durability,
    PartialRemoval,
    OperationAndCleanup,
    EngineTimeout,
    EnginePositionRejected,
    EngineRetired,
    EngineFailure,
    Permission,
    PuzzleThemesUnavailable,
}

impl std::fmt::Display for ErrorCategory {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::Io => "I/O failure",
            Self::Parsing => "parsing failure",
            Self::Platform => "platform failure",
            Self::Network => "network failure",
            Self::ChessData => "chess data failure",
            Self::Database => "database failure",
            Self::InvalidInput => "invalid input",
            Self::StaleGame => "stale game",
            Self::MissingResource => "missing resource",
            Self::Conflict => "conflict",
            Self::ResourceLimit => "resource limit",
            Self::Authentication => "authentication failure",
            Self::Credential => "credential failure",
            Self::Cancellation => "cancellation",
            Self::Durability => "durability failure",
            Self::PartialRemoval => "partial removal",
            Self::OperationAndCleanup => "operation and cleanup failure",
            Self::EngineTimeout => "engine timeout",
            Self::EnginePositionRejected => "engine position rejected",
            Self::EngineRetired => "engine retired",
            Self::EngineFailure => "engine failure",
            Self::Permission => "permission denied",
            Self::PuzzleThemesUnavailable => "puzzle themes unavailable",
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum ErrorPayloadTag {
    BackendError,
    EngineFailure,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RemoteHttpRejection {
    pub status: u16,
    pub authorization_sent: bool,
}

impl std::fmt::Display for RemoteHttpRejection {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "Remote HTTP request rejected: status {}",
            self.status
        )
    }
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ErrorPayload {
    pub tag: ErrorPayloadTag,
    pub category: ErrorCategory,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub root_failure: Option<RootFailure>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub engine_failure: Option<Box<crate::engine::EngineTerminalSnapshot>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub remote_http_rejection: Option<RemoteHttpRejection>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub name_taken: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub database_admission: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub database_busy: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub progress_generation: Option<crate::progress::ProgressGeneration>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum RootFailure {
    Changed,
    Missing,
    Unusable,
    Permission,
    TooLarge,
}

pub(crate) const WORKSPACE_FILE_NAME_TAKEN: &str = "workspace file already exists";
pub(crate) const DATABASE_OPEN_THROUGH_ANOTHER_DIRECTORY: &str =
    "database is open through another directory";
pub(crate) const DATABASE_OPEN_THROUGH_ANOTHER_NAME: &str = "database is open through another name";

#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// Shares a pending actor's terminal failure without changing its observable error.
    #[error(transparent)]
    Shared(std::sync::Arc<Error>),
    #[error("{error}")]
    RootFailure {
        error: Box<Error>,
        reason: RootFailure,
    },
    #[error("I/O failure")]
    Io(#[source] Box<std::io::Error>),

    #[error("parsing failure")]
    Zip(#[source] Box<zip::result::ZipError>),

    #[error(transparent)]
    ParseInt(Box<std::num::ParseIntError>),

    #[error("platform failure")]
    Tauri(#[source] Box<tauri::Error>),

    #[error("platform failure")]
    TauriOpener(#[source] Box<tauri_plugin_opener::Error>),

    #[error("network failure")]
    Reqwest(#[source] Box<reqwest::Error>),

    #[error("{0}")]
    RemoteHttpRejection(RemoteHttpRejection),

    #[error(transparent)]
    ChessPosition(Box<shakmaty::PositionError<Chess>>),

    #[error(transparent)]
    IllegalUciMove(Box<shakmaty::uci::IllegalUciMoveError>),

    #[error(transparent)]
    ParseUciMove(Box<shakmaty::uci::ParseUciMoveError>),

    #[error(transparent)]
    Fen(Box<shakmaty::fen::ParseFenError>),

    #[error(transparent)]
    ParseSan(Box<shakmaty::san::ParseSanError>),

    #[error(transparent)]
    IllegalSan(Box<shakmaty::san::SanError>),

    #[error("database failure")]
    Diesel(#[source] Box<diesel::result::Error>),

    #[error("database failure")]
    R2d2(#[source] Box<diesel::r2d2::PoolError>),

    #[error(transparent)]
    SystemTime(Box<std::time::SystemTimeError>),

    #[error("No stdin")]
    NoStdin,

    #[error("No stdout")]
    NoStdout,

    #[error("No moves found")]
    NoMovesFound,

    #[error("Missing reference database")]
    MissingReferenceDatabase,

    #[error("No opening found")]
    NoOpeningFound,

    #[error("No puzzles")]
    NoPuzzles,

    #[error("Puzzle themes unavailable")]
    PuzzleThemesUnavailable,

    #[error("Players aren't the same. They have played against each other")]
    NotDistinctPlayers,

    #[error("Game not found: {0}")]
    GameNotFound(String),

    #[error("Game not in progress")]
    GameNotInProgress,

    #[error("Not human's turn")]
    NotHumanTurn,

    #[error("Not engine's turn")]
    NotEngineTurn,

    #[error("Invalid color: {0}")]
    InvalidColor(String),

    #[error("Engine not initialized")]
    EngineNotInitialized,

    #[error("Engine disconnected")]
    EngineDisconnected,

    #[error("Engine failed{}", if .cleanup.is_some() { ". Temporary cleanup also failed" } else { "" })]
    EngineFailure {
        snapshot: Option<Box<crate::engine::EngineTerminalSnapshot>>,
        #[source]
        cause: Box<Error>,
        cleanup: Option<Box<Error>>,
    },

    #[error("Engine timeout: {0}")]
    EngineTimeout(String),

    #[error("Position cannot be played against an engine")]
    EnginePositionRejected(#[source] Box<Error>),

    #[error("Engine id is retired")]
    EngineRetired,

    #[error("Analysis cancelled")]
    AnalysisCancelled,
    #[error("Invalid input: {0}")]
    InvalidInput(String),

    #[error("Invalid input: {kind}")]
    NativeFolderSelection {
        kind: &'static str,
        #[source]
        cause: Box<dyn std::error::Error + Send + Sync>,
    },

    #[error("The game changed on disk")]
    StaleGame,

    #[error("The file was moved to the trash")]
    FileTrashed,

    #[error("The file or folder is no longer available to the app")]
    UnknownPathCapability,

    #[error("Conflict: {0}")]
    Conflict(String),

    #[error("Progress lease is stale, cleared, or expired")]
    StaleProgressLease,

    #[error("Resource limit: {0}")]
    ResourceLimit(String),

    #[error("OAuth failure: {0}")]
    OAuthFailure(String),

    #[error("Credential operation failed")]
    CredentialFailure(String),

    #[error("Credential operation requires recovery")]
    CredentialRecoveryRequired,

    #[error("Cancellation")]
    Cancellation,

    #[error("Committed but durability uncertain: {0}")]
    CommittedDurabilityUncertain(DurabilityStage),

    #[error(
        "Partially removed: {removed_entries} entries were deleted before failing: {}",
        .cause.category()
    )]
    PartialRemoval {
        removed_entries: usize,
        #[source]
        cause: Box<Error>,
    },

    #[error("Operation failed; temporary cleanup also failed")]
    OperationAndCleanup { primary: String, cleanup: String },
}

/// Whether the OS reported that the named filesystem entry does not exist.
/// Raw OS codes are authoritative: unix accepts only `ENOENT`, and Windows accepts only
/// `ERROR_FILE_NOT_FOUND` / `ERROR_PATH_NOT_FOUND`. Without a raw code, synthetic
/// `ErrorKind::NotFound` means absence. This is narrower than Windows' `ErrorKind::NotFound`,
/// which also includes `ERROR_INVALID_DRIVE` (15), `ERROR_BAD_NETPATH` (53), and
/// `ERROR_BAD_NET_NAME` (67). Producer-layer rustix `Errno::NOENT` and SQLite VFS comparisons
/// use the same platform sets before an I/O error exists.
pub fn is_missing_entry_io(error: &std::io::Error) -> bool {
    match error.raw_os_error() {
        Some(code) => {
            #[cfg(unix)]
            {
                code == libc::ENOENT
            }
            #[cfg(windows)]
            {
                use windows_sys::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND};
                code == ERROR_FILE_NOT_FOUND as i32 || code == ERROR_PATH_NOT_FOUND as i32
            }
        }
        None => error.kind() == std::io::ErrorKind::NotFound,
    }
}

/// Replaces native error text while preserving missing-entry classification and other kinds.
/// A raw-coded `NotFound` that is not absence becomes generic I/O, rather than a synthetic
/// missing entry after its raw code is removed.
pub fn sanitized_io_error(error: &std::io::Error, message: String) -> std::io::Error {
    let kind = if is_missing_entry_io(error) {
        std::io::ErrorKind::NotFound
    } else if error.kind() == std::io::ErrorKind::NotFound {
        std::io::ErrorKind::Other
    } else {
        error.kind()
    };
    std::io::Error::new(kind, message)
}

impl Error {
    pub(crate) fn is_database_busy(&self) -> bool {
        match self.unlabelled() {
            Self::Diesel(error) => {
                matches!(error.as_ref(), diesel::result::Error::DatabaseError(_, information)
                if matches!(information.message(), "database is locked" | "database table is locked" | "database schema is locked")
                    || information.message().starts_with("database table is locked:")
                    || information.message().starts_with("database schema is locked:"))
            }
            Self::R2d2(error) => {
                let message = error.to_string();
                message == "timed out waiting for connection"
                    || message.contains("database is locked")
                    || message.contains("database table is locked")
                    || message.contains("database schema is locked")
            }
            Self::Conflict(message) => matches!(
                message.as_str(),
                "database connection acquisition timed out" | DATABASE_SCHEMA_NOT_CURRENT
            ),
            _ => false,
        }
    }

    #[cfg(test)]
    pub(crate) fn without_shared(&self) -> &Self {
        let mut error = self;
        while let Self::Shared(inner) = error {
            error = inner;
        }
        error
    }
}

impl Error {
    /// Keeps the folder conversion cause in native diagnostics, outside the public message.
    pub(crate) fn native_folder_selection(
        kind: &'static str,
        cause: impl std::error::Error + Send + Sync + 'static,
    ) -> Self {
        let error = Self::NativeFolderSelection {
            kind,
            cause: Box::new(cause),
        };
        log::error!("{}", error.diagnostic());
        error
    }

    /// Task panic payloads belong to native diagnostics, never public messages.
    pub(crate) fn task_join(
        context: &'static str,
        error: &tokio::task::JoinError,
        owner: &str,
    ) -> Self {
        log::error!("{context} owner={owner}: {error}");
        Self::Conflict(context.into())
    }

    /// True only for an I/O error reporting absence as defined by [`is_missing_entry_io`].
    pub fn is_missing_entry(&self) -> bool {
        if let Self::Shared(error) = self {
            return error.is_missing_entry();
        }
        matches!(self, Self::Io(error) if is_missing_entry_io(error))
    }

    pub(crate) fn with_root_failure(self, reason: RootFailure) -> Self {
        if self.root_failure().is_some() {
            return self;
        }
        Self::RootFailure {
            error: Box::new(self),
            reason,
        }
    }

    pub(crate) fn root_failure(&self) -> Option<RootFailure> {
        match self {
            Self::Shared(error) => error.root_failure(),
            Self::RootFailure { reason, .. } => Some(*reason),
            _ => None,
        }
    }

    /// Only use for failures from resolving, enumerating or acquiring the chosen root.
    pub(crate) fn root_failure_reason(&self) -> Option<RootFailure> {
        match self {
            Self::Shared(error) => error.root_failure_reason(),
            Self::RootFailure { reason, .. } => Some(*reason),
            Self::Io(_) if self.is_missing_entry() => Some(RootFailure::Missing),
            Self::Io(error) => match error.kind() {
                std::io::ErrorKind::NotFound => Some(RootFailure::Missing),
                std::io::ErrorKind::PermissionDenied => Some(RootFailure::Permission),
                std::io::ErrorKind::InvalidInput => Some(RootFailure::Unusable),
                _ => None,
            },
            Self::InvalidInput(_) | Self::NativeFolderSelection { .. } => {
                Some(RootFailure::Unusable)
            }
            Self::Conflict(_) => Some(RootFailure::Changed),
            _ => None,
        }
    }

    pub(crate) fn label_root_failure(self) -> Self {
        match self.root_failure_reason() {
            Some(reason) => self.with_root_failure(reason),
            None => self,
        }
    }

    pub(crate) fn unlabelled(&self) -> &Self {
        match self {
            Self::Shared(error) => error.unlabelled(),
            Self::RootFailure { error, .. } => error.unlabelled(),
            _ => self,
        }
    }

    /// Returns the local diagnostic without changing the message exposed on the wire.
    pub(crate) fn diagnostic(&self) -> String {
        if let Self::EngineFailure { cause, cleanup, .. } = self {
            return match cleanup {
                Some(cleanup) => format!(
                    "primary={}; cleanup={}",
                    cause.diagnostic(),
                    cleanup.diagnostic()
                ),
                None => cause.diagnostic(),
            };
        }
        if let Self::Shared(error) = self {
            return error.diagnostic();
        }
        if let Self::RootFailure { error, .. } = self {
            return error.diagnostic();
        }
        if let Self::OperationAndCleanup { primary, cleanup } = self {
            return format!("primary={primary}; cleanup={cleanup}");
        }

        let mut diagnostic = self.to_string();
        let mut source = std::error::Error::source(self);
        while let Some(cause) = source {
            let cause_text = cause.to_string();
            if !diagnostic.ends_with(&cause_text) {
                diagnostic.push_str(": ");
                diagnostic.push_str(&cause_text);
            }
            source = cause.source();
        }
        diagnostic
    }

    pub fn category(&self) -> ErrorCategory {
        match self {
            Self::Shared(error) => error.category(),
            Self::RootFailure { error, .. } => error.category(),
            Self::Io(_) if self.is_missing_entry() => ErrorCategory::MissingResource,
            Self::Io(error) => match error.kind() {
                std::io::ErrorKind::PermissionDenied => ErrorCategory::Permission,
                _ => ErrorCategory::Io,
            },
            Self::Zip(_) | Self::ParseInt(_) | Self::Fen(_) | Self::ParseUciMove(_) => {
                ErrorCategory::Parsing
            }
            Self::Tauri(_) | Self::TauriOpener(_) => ErrorCategory::Platform,
            Self::Reqwest(_) => ErrorCategory::Network,
            Self::RemoteHttpRejection(detail) => match detail.status {
                401 => ErrorCategory::Authentication,
                403 => ErrorCategory::Permission,
                404 => ErrorCategory::MissingResource,
                _ => ErrorCategory::Network,
            },
            Self::ChessPosition(_)
            | Self::IllegalUciMove(_)
            | Self::ParseSan(_)
            | Self::IllegalSan(_) => ErrorCategory::ChessData,
            Self::Diesel(_) | Self::R2d2(_) => ErrorCategory::Database,
            Self::SystemTime(_)
            | Self::InvalidInput(_)
            | Self::NativeFolderSelection { .. }
            | Self::InvalidColor(_) => ErrorCategory::InvalidInput,
            Self::StaleGame => ErrorCategory::StaleGame,
            Self::NoStdin
            | Self::NoStdout
            | Self::NoMovesFound
            | Self::MissingReferenceDatabase
            | Self::NoOpeningFound
            | Self::NoPuzzles
            | Self::GameNotFound(_)
            | Self::FileTrashed
            | Self::UnknownPathCapability
            | Self::EngineNotInitialized
            | Self::EngineDisconnected => ErrorCategory::MissingResource,
            Self::NotDistinctPlayers
            | Self::GameNotInProgress
            | Self::NotHumanTurn
            | Self::NotEngineTurn
            | Self::Conflict(_)
            | Self::StaleProgressLease => ErrorCategory::Conflict,
            Self::ResourceLimit(_) => ErrorCategory::ResourceLimit,
            Self::OAuthFailure(_) => ErrorCategory::Authentication,
            Self::CredentialFailure(_) | Self::CredentialRecoveryRequired => {
                ErrorCategory::Credential
            }
            Self::Cancellation | Self::AnalysisCancelled => ErrorCategory::Cancellation,
            Self::CommittedDurabilityUncertain(_) => ErrorCategory::Durability,
            Self::PartialRemoval { .. } => ErrorCategory::PartialRemoval,
            Self::OperationAndCleanup { .. } => ErrorCategory::OperationAndCleanup,
            Self::EngineTimeout(_) => ErrorCategory::EngineTimeout,
            Self::EnginePositionRejected(_) => ErrorCategory::EnginePositionRejected,
            Self::EngineRetired => ErrorCategory::EngineRetired,
            Self::EngineFailure {
                cleanup: Some(_), ..
            } => ErrorCategory::OperationAndCleanup,
            Self::EngineFailure { .. } => ErrorCategory::EngineFailure,
            Self::PuzzleThemesUnavailable => ErrorCategory::PuzzleThemesUnavailable,
        }
    }

    /// Preserves the operation error and appends a cleanup failure when one exists.
    pub(crate) fn with_cleanup(primary: Error, cleanup: Result<(), Error>) -> Error {
        match (primary, cleanup) {
            (primary, Ok(())) => primary,
            (
                Self::EngineFailure {
                    snapshot,
                    cause,
                    cleanup: None,
                },
                Err(cleanup),
            ) => Self::EngineFailure {
                snapshot,
                cause,
                cleanup: Some(Box::new(cleanup)),
            },
            (primary, Err(cleanup)) if primary.is_engine_failure() => Self::EngineFailure {
                snapshot: primary.engine_failure_snapshot().cloned().map(Box::new),
                cause: Box::new(primary),
                cleanup: Some(Box::new(cleanup)),
            },
            (primary, Err(cleanup)) => Self::OperationAndCleanup {
                primary: primary.diagnostic(),
                cleanup: cleanup.diagnostic(),
            },
        }
    }

    pub(crate) fn is_engine_failure(&self) -> bool {
        match self {
            Self::Shared(error) => error.is_engine_failure(),
            Self::RootFailure { error, .. } => error.is_engine_failure(),
            Self::EngineFailure { .. } => true,
            _ => false,
        }
    }

    pub(crate) fn remote_http_rejection(&self) -> Option<RemoteHttpRejection> {
        match self {
            Self::Shared(error) => error.remote_http_rejection(),
            Self::RootFailure { error, .. } => error.remote_http_rejection(),
            Self::RemoteHttpRejection(detail) => Some(*detail),
            _ => None,
        }
    }

    pub(crate) fn engine_failure_snapshot(&self) -> Option<&crate::engine::EngineTerminalSnapshot> {
        match self {
            Self::Shared(error) => error.engine_failure_snapshot(),
            Self::RootFailure { error, .. } => error.engine_failure_snapshot(),
            Self::EngineFailure { snapshot, .. } => snapshot.as_deref(),
            _ => None,
        }
    }
}

/// Classifies expected search-stop consequences without hiding cleanup failures.
pub(crate) fn cancelled_search_error(error: Error, cancelled: bool) -> Error {
    match error {
        Error::Cancellation | Error::AnalysisCancelled | Error::EngineDisconnected if cancelled => {
            Error::Cancellation
        }
        error => error,
    }
}

const SQLITE_NOTADB: i32 = 26;

/// Constructed only once the primary entry is gone; keeps the first recorded failure, whatever its class.
/// Later failures are logged at warn with their diagnostic and dropped, never combined.
/// `finish` returns a kept `CommittedDurabilityUncertain` unchanged and wraps any other kept failure in `PartialRemoval`.
#[derive(Debug)]
#[must_use]
pub(crate) struct CommittedRemoval {
    removed_entries: usize,
    failure: Option<Error>,
}

impl CommittedRemoval {
    pub(crate) fn new(removed_entries: usize, failure: Option<Error>) -> Self {
        Self {
            removed_entries,
            failure,
        }
    }

    pub(crate) fn add_removed_entries(&mut self, count: usize) {
        self.removed_entries += count;
    }

    pub(crate) fn record(
        &mut self,
        result: Result<(), Error>,
        subject: &str,
        path: &std::path::Path,
    ) {
        if let Err(error) = result {
            if let Some(kept) = &self.failure {
                let failure = if matches!(kept, Error::CommittedDurabilityUncertain(_)) {
                    "durability uncertainty"
                } else {
                    "partial removal"
                };
                log::warn!(
                    "{subject} failed after {failure} for {} (kept category: {:?}): {}",
                    path.display(),
                    kept.category(),
                    error.diagnostic()
                );
            } else {
                self.failure = Some(error);
            }
        }
    }

    pub(crate) fn finish(self) -> Result<(), Error> {
        match self.failure {
            None => Ok(()),
            Some(error @ Error::CommittedDurabilityUncertain(_)) => Err(error),
            Some(error) => Err(Error::PartialRemoval {
                removed_entries: self.removed_entries,
                cause: Box::new(error),
            }),
        }
    }

    pub(crate) fn into_parts(self) -> (usize, Option<Error>) {
        (self.removed_entries, self.failure)
    }
}

#[cfg(test)]
mod missing_entry_tests {
    use super::*;
    use std::io::{self, ErrorKind};

    fn assert_missing_entry_class(source: io::Error, missing: bool, category: ErrorCategory) {
        assert_eq!(is_missing_entry_io(&source), missing, "{source:?}");
        let rebuilt = sanitized_io_error(&source, "sanitised failure".into());
        assert_eq!(is_missing_entry_io(&rebuilt), missing);
        let expected_kind = if missing {
            ErrorKind::NotFound
        } else if source.kind() == ErrorKind::NotFound {
            ErrorKind::Other
        } else {
            source.kind()
        };
        assert_eq!(rebuilt.kind(), expected_kind);
        assert_eq!(rebuilt.raw_os_error(), None);
        assert_eq!(rebuilt.to_string(), "sanitised failure");
        let original = Error::from(source);
        let rebuilt = Error::from(rebuilt);
        for error in [original, rebuilt] {
            assert_eq!(error.is_missing_entry(), missing, "{error:?}");
            assert_eq!(error.category(), category, "{error:?}");
            if missing
                || matches!(&error, Error::Io(source) if source.kind() == ErrorKind::NotFound)
            {
                assert_eq!(error.root_failure_reason(), Some(RootFailure::Missing));
            } else {
                assert_ne!(error.root_failure_reason(), Some(RootFailure::Missing));
                if category == ErrorCategory::Permission {
                    assert_eq!(error.root_failure_reason(), Some(RootFailure::Permission));
                }
            }
        }
    }

    #[test]
    fn missing_entry_synthetic_errors_and_sanitising_helper() {
        assert_missing_entry_class(
            io::Error::from(ErrorKind::NotFound),
            true,
            ErrorCategory::MissingResource,
        );
        assert_missing_entry_class(
            io::Error::new(ErrorKind::NotFound, "absent"),
            true,
            ErrorCategory::MissingResource,
        );
        assert_missing_entry_class(io::Error::other("failure"), false, ErrorCategory::Io);
        assert!(!Error::Conflict("changed".into()).is_missing_entry());
        assert!(!Error::InvalidInput("invalid".into()).is_missing_entry());
    }

    #[cfg(unix)]
    #[test]
    fn missing_entry_unix_raw_errors_and_consumers() {
        for (raw, missing, category) in [
            (libc::ENOENT, true, ErrorCategory::MissingResource),
            (libc::ESRCH, false, ErrorCategory::Io),
            (libc::EACCES, false, ErrorCategory::Permission),
        ] {
            assert_missing_entry_class(io::Error::from_raw_os_error(raw), missing, category);
        }
    }

    #[cfg(windows)]
    #[test]
    fn missing_entry_windows_raw_errors_and_consumers() {
        use windows_sys::Win32::Foundation::{
            ERROR_ACCESS_DENIED, ERROR_BAD_NETPATH, ERROR_BAD_NET_NAME, ERROR_FILE_NOT_FOUND,
            ERROR_INVALID_DRIVE, ERROR_PATH_NOT_FOUND,
        };
        for (raw, missing, category) in [
            (ERROR_FILE_NOT_FOUND, true, ErrorCategory::MissingResource),
            (ERROR_PATH_NOT_FOUND, true, ErrorCategory::MissingResource),
            (ERROR_INVALID_DRIVE, false, ErrorCategory::Io),
            (ERROR_BAD_NETPATH, false, ErrorCategory::Io),
            (ERROR_BAD_NET_NAME, false, ErrorCategory::Io),
            (ERROR_ACCESS_DENIED, false, ErrorCategory::Permission),
        ] {
            assert_missing_entry_class(io::Error::from_raw_os_error(raw as i32), missing, category);
        }
    }
}

#[cfg(test)]
mod root_failure_tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn root_failure_missing_drive_and_network_preserves_narrow_missing_entry_class() {
        use windows_sys::Win32::Foundation::{
            ERROR_BAD_NETPATH, ERROR_BAD_NET_NAME, ERROR_INVALID_DRIVE,
        };
        for raw in [ERROR_INVALID_DRIVE, ERROR_BAD_NETPATH, ERROR_BAD_NET_NAME] {
            let error = Error::from(std::io::Error::from_raw_os_error(raw as i32));
            assert_eq!(error.root_failure_reason(), Some(RootFailure::Missing));
            assert_eq!(
                error.label_root_failure().root_failure(),
                Some(RootFailure::Missing)
            );
        }
    }

    #[test]
    fn root_failure_serialization_and_diagnostics_are_additive() {
        let errors = [
            (
                Error::from(std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    "native missing",
                )),
                RootFailure::Missing,
            ),
            (
                Error::from(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "native permission",
                )),
                RootFailure::Permission,
            ),
            (
                Error::InvalidInput("root shape".into()),
                RootFailure::Unusable,
            ),
            (
                Error::Conflict("root identity".into()),
                RootFailure::Changed,
            ),
            (
                Error::ResourceLimit("listing bound".into()),
                RootFailure::TooLarge,
            ),
            (
                Error::OperationAndCleanup {
                    primary: "primary".into(),
                    cleanup: "cleanup".into(),
                },
                RootFailure::Changed,
            ),
        ];
        for (error, reason) in errors {
            let before = serde_json::to_value(&error).unwrap();
            assert!(before.get("rootFailure").is_none());
            let diagnostic = error.diagnostic();
            let labelled = error.with_root_failure(reason);
            let after = serde_json::to_value(&labelled).unwrap();
            assert_eq!(after["category"], before["category"]);
            assert_eq!(after["message"], before["message"]);
            assert_eq!(labelled.diagnostic(), diagnostic);
            assert_eq!(after["rootFailure"], serde_json::to_value(reason).unwrap());
            assert_eq!(
                labelled
                    .with_root_failure(RootFailure::Permission)
                    .root_failure(),
                Some(reason)
            );
        }
    }

    #[test]
    fn root_failure_mapping_excludes_non_listing_resource_limits_and_other_errors() {
        for error in [
            Error::Cancellation,
            Error::ResourceLimit("registry capacity".into()),
            Error::CommittedDurabilityUncertain(DurabilityStage::RegistryReplacement),
            Error::from(std::io::Error::other("native failure")),
        ] {
            assert_eq!(error.root_failure_reason(), None);
            assert_eq!(error.label_root_failure().root_failure(), None);
        }
        let error = Error::from(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "root shape",
        ));
        assert_eq!(error.root_failure_reason(), Some(RootFailure::Unusable));
    }
}

fn sqlite_notadb_message(message: &str) -> bool {
    let message = message.to_ascii_lowercase();
    let code = SQLITE_NOTADB.to_string();
    message.contains("not a database")
        || message.contains("notadb")
        || message.contains(&format!("code {code}"))
        || message.contains(&format!("code: {code}"))
        || message.contains(&format!("({code})"))
        || message.trim() == code
        || message.ends_with(&format!(" {code}"))
}

pub(crate) fn is_sqlite_notadb(error: &Error) -> bool {
    match error.unlabelled() {
        Error::InvalidInput(message) => message == "SQLite file is not a database",
        Error::Diesel(error) => match error.as_ref() {
            diesel::result::Error::DatabaseError(_, information) => {
                sqlite_notadb_message(information.message())
            }
            _ => false,
        },
        _ => false,
    }
}

pub(crate) fn map_sqlite_establish(error: diesel::ConnectionError) -> Error {
    let notadb = match &error {
        diesel::ConnectionError::BadConnection(message) => sqlite_notadb_message(message),
        diesel::ConnectionError::CouldntSetupConfiguration(
            diesel::result::Error::DatabaseError(_, information),
        ) => sqlite_notadb_message(information.message()),
        _ => false,
    };
    if notadb {
        Error::InvalidInput("SQLite file is not a database".into())
    } else {
        log::warn!("could not open SQLite database: {error}");
        match error {
            diesel::ConnectionError::InvalidCString(_)
            | diesel::ConnectionError::InvalidConnectionUrl(_) => {
                Error::InvalidInput("could not open SQLite database".into())
            }
            diesel::ConnectionError::CouldntSetupConfiguration(error) => Error::from(error),
            error => Error::from(std::io::Error::other(error)),
        }
    }
}

impl From<std::io::Error> for Error {
    fn from(value: std::io::Error) -> Self {
        Self::Io(Box::new(value))
    }
}

impl From<zip::result::ZipError> for Error {
    fn from(value: zip::result::ZipError) -> Self {
        Self::Zip(Box::new(value))
    }
}

impl From<std::num::ParseIntError> for Error {
    fn from(value: std::num::ParseIntError) -> Self {
        Self::ParseInt(Box::new(value))
    }
}

impl From<tauri::Error> for Error {
    fn from(value: tauri::Error) -> Self {
        Self::Tauri(Box::new(value))
    }
}

impl From<tauri_plugin_opener::Error> for Error {
    fn from(value: tauri_plugin_opener::Error) -> Self {
        Self::TauriOpener(Box::new(value))
    }
}

impl From<reqwest::Error> for Error {
    fn from(value: reqwest::Error) -> Self {
        Self::Reqwest(Box::new(value))
    }
}

impl From<shakmaty::PositionError<Chess>> for Error {
    fn from(value: shakmaty::PositionError<Chess>) -> Self {
        Self::ChessPosition(Box::new(value))
    }
}

impl From<shakmaty::uci::IllegalUciMoveError> for Error {
    fn from(value: shakmaty::uci::IllegalUciMoveError) -> Self {
        Self::IllegalUciMove(Box::new(value))
    }
}

impl From<shakmaty::uci::ParseUciMoveError> for Error {
    fn from(value: shakmaty::uci::ParseUciMoveError) -> Self {
        Self::ParseUciMove(Box::new(value))
    }
}

impl From<shakmaty::fen::ParseFenError> for Error {
    fn from(value: shakmaty::fen::ParseFenError) -> Self {
        Self::Fen(Box::new(value))
    }
}

impl From<shakmaty::san::ParseSanError> for Error {
    fn from(value: shakmaty::san::ParseSanError) -> Self {
        Self::ParseSan(Box::new(value))
    }
}

impl From<shakmaty::san::SanError> for Error {
    fn from(value: shakmaty::san::SanError) -> Self {
        Self::IllegalSan(Box::new(value))
    }
}

impl From<diesel::result::Error> for Error {
    fn from(value: diesel::result::Error) -> Self {
        Self::Diesel(Box::new(value))
    }
}

impl From<diesel::r2d2::PoolError> for Error {
    fn from(value: diesel::r2d2::PoolError) -> Self {
        Self::R2d2(Box::new(value))
    }
}

impl From<std::time::SystemTimeError> for Error {
    fn from(value: std::time::SystemTimeError) -> Self {
        Self::SystemTime(Box::new(value))
    }
}

impl Error {
    pub(crate) fn renderer_payload(&self) -> ErrorPayload {
        // Backend log records do not reach the renderer; the payload stays on the fixed Display.
        ErrorPayload {
            tag: if self.is_engine_failure() {
                ErrorPayloadTag::EngineFailure
            } else {
                ErrorPayloadTag::BackendError
            },
            category: self.category(),
            message: self.to_string(),
            root_failure: self.root_failure(),
            engine_failure: self.engine_failure_snapshot().cloned().map(Box::new),
            remote_http_rejection: self.remote_http_rejection(),
            name_taken:
                matches!(self, Self::Conflict(message) if message == WORKSPACE_FILE_NAME_TAKEN)
                    .then_some(true),
            database_admission: matches!(self, Self::Conflict(message)
                if message == DATABASE_OPEN_THROUGH_ANOTHER_DIRECTORY
                    || message == DATABASE_OPEN_THROUGH_ANOTHER_NAME)
            .then_some(true),
            database_busy: self.is_database_busy().then_some(true),
            progress_generation: None,
        }
    }
}

impl serde::Serialize for Error {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::ser::Serializer,
    {
        self.renderer_payload().serialize(serializer)
    }
}

impl Type for Error {
    fn inline(
        type_map: &mut specta::TypeMap,
        generics: specta::Generics,
    ) -> specta::datatype::DataType {
        ErrorPayload::inline(type_map, generics)
    }

    fn reference(
        type_map: &mut specta::TypeMap,
        generics: &[specta::datatype::DataType],
    ) -> specta::datatype::reference::Reference {
        // Result uses E::reference; specta's default inlines and would omit a named type.
        ErrorPayload::reference(type_map, generics)
    }
}

#[cfg(test)]
#[derive(Clone, Debug)]
pub(crate) struct CapturedLogRecord {
    pub level: log::Level,
    pub message: String,
}

#[cfg(test)]
pub(crate) struct LogCaptureScope {
    prev: Option<Vec<CapturedLogRecord>>,
}

#[cfg(test)]
struct CapturingLogger;

#[cfg(test)]
static CAPTURING_LOGGER: CapturingLogger = CapturingLogger;
#[cfg(test)]
static LOGGER_INIT: std::sync::Once = std::sync::Once::new();

#[cfg(test)]
thread_local! {
    static LOCAL_CAPTURE: std::cell::RefCell<Option<Vec<CapturedLogRecord>>> = const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
impl log::Log for CapturingLogger {
    fn enabled(&self, metadata: &log::Metadata<'_>) -> bool {
        metadata.level() <= log::Level::Info
    }

    fn log(&self, record: &log::Record<'_>) {
        if self.enabled(record.metadata()) {
            let captured = CapturedLogRecord {
                level: record.level(),
                message: record.args().to_string(),
            };
            LOCAL_CAPTURE.with(|cell| {
                if let Some(logs) = cell.borrow_mut().as_mut() {
                    logs.push(captured);
                }
            });
        }
    }

    fn flush(&self) {}
}

#[cfg(test)]
fn install_capturing_logger() {
    LOGGER_INIT.call_once(|| {
        log::set_logger(&CAPTURING_LOGGER)
            .expect("capturing logger could not be installed in this test binary");
        log::set_max_level(log::LevelFilter::Info);
    });
}

#[cfg(test)]
impl LogCaptureScope {
    pub(crate) fn start() -> Self {
        install_capturing_logger();
        let prev = LOCAL_CAPTURE.with(|cell| cell.borrow_mut().replace(Vec::new()));
        Self { prev }
    }

    pub(crate) fn records(&self) -> Vec<CapturedLogRecord> {
        LOCAL_CAPTURE.with(|cell| {
            cell.borrow()
                .as_ref()
                .map(|logs| logs.clone())
                .unwrap_or_default()
        })
    }

    pub(crate) fn messages(&self) -> Vec<String> {
        self.records().into_iter().map(|r| r.message).collect()
    }
}

#[cfg(test)]
impl Drop for LogCaptureScope {
    fn drop(&mut self) {
        LOCAL_CAPTURE.with(|cell| {
            *cell.borrow_mut() = self.prev.take();
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_native_folder_selection_redaction(kind: &'static str, marker: &str) {
        let capture = LogCaptureScope::start();
        let cause = format!("folder conversion rejected {marker}");
        let error = Error::native_folder_selection(kind, std::io::Error::other(cause.clone()));
        let serialized = serde_json::to_string(&error).expect("serialize folder selection error");
        let payload: serde_json::Value =
            serde_json::from_str(&serialized).expect("folder selection payload");
        assert!(!serialized.contains(marker));
        assert!(!serialized.contains(&cause));
        assert_eq!(payload["message"], format!("Invalid input: {kind}"));
        assert_eq!(payload["category"], "invalid-input");
        assert_eq!(error.to_string(), format!("Invalid input: {kind}"));
        assert_eq!(error.category(), ErrorCategory::InvalidInput);
        assert_eq!(error.root_failure_reason(), Some(RootFailure::Unusable));
        assert_eq!(error.root_failure(), None);
        assert_eq!(payload.as_object().expect("error object").len(), 3);
        assert!(error.diagnostic().contains(&cause));
        assert!(std::error::Error::source(&error)
            .expect("conversion source")
            .to_string()
            .contains(&cause));
        assert!(capture.records().iter().any(|record| {
            record.level == log::Level::Error && record.message.contains(&cause)
        }));
    }

    #[test]
    fn native_folder_selection_redacts_native_phrase_and_logs_cause() {
        assert_native_folder_selection_redaction(
            "invalid native folder selection",
            "/private/secret-folder-selection-native",
        );
    }

    #[test]
    fn native_folder_selection_redacts_database_phrase_and_logs_cause() {
        assert_native_folder_selection_redaction(
            "invalid database folder selection",
            "/private/secret-folder-selection-database",
        );
    }

    #[test]
    fn workspace_file_name_taken_payload_marks_only_the_owned_conflict() {
        let error = Error::Conflict(WORKSPACE_FILE_NAME_TAKEN.into());
        let payload = serde_json::to_value(&error).expect("name-taken payload");
        assert_eq!(payload["category"], "conflict");
        assert_eq!(
            payload["message"],
            format!("Conflict: {WORKSPACE_FILE_NAME_TAKEN}")
        );
        assert_eq!(payload["nameTaken"], true);
        for error in [
            Error::Conflict("target was created concurrently".into()),
            Error::Conflict(format!("{WORKSPACE_FILE_NAME_TAKEN} elsewhere")),
            Error::InvalidInput(WORKSPACE_FILE_NAME_TAKEN.into()),
            Error::with_cleanup(
                Error::Conflict(WORKSPACE_FILE_NAME_TAKEN.into()),
                Err(Error::InvalidInput("cleanup failed".into())),
            ),
        ] {
            let payload = serde_json::to_value(error).expect("other payload");
            assert!(payload.get("nameTaken").is_none());
        }
    }

    #[test]
    fn real_sqlite_busy_is_flagged_directly_and_through_the_shared_pool_error() {
        use diesel::{connection::SimpleConnection, Connection, RunQueryDsl};
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("busy.db3");
        let writer = rusqlite::Connection::open(&path).unwrap();
        writer
            .execute_batch("CREATE TABLE Busy(Value INTEGER); BEGIN IMMEDIATE;")
            .unwrap();
        let mut connection = diesel::SqliteConnection::establish(path.to_str().unwrap()).unwrap();
        connection.batch_execute("PRAGMA busy_timeout=0").unwrap();
        let error = Error::from(
            diesel::sql_query("INSERT INTO Busy VALUES(1)")
                .execute(&mut connection)
                .unwrap_err(),
        );
        assert_eq!(serde_json::to_value(&error).unwrap()["databaseBusy"], true);
        let shared = Error::Shared(std::sync::Arc::new(error));
        assert_eq!(serde_json::to_value(shared).unwrap()["databaseBusy"], true);
    }

    #[test]
    fn only_busy_owned_conflicts_and_sqlite_lock_errors_receive_database_busy() {
        for error in [
            Error::Conflict(DATABASE_SCHEMA_NOT_CURRENT.into()),
            Error::Conflict("database connection acquisition timed out".into()),
        ] {
            assert_eq!(serde_json::to_value(error).unwrap()["databaseBusy"], true);
        }
        for error in [
            Error::Conflict("other conflict".into()),
            Error::InvalidInput("database is locked".into()),
        ] {
            assert!(serde_json::to_value(error)
                .unwrap()
                .get("databaseBusy")
                .is_none());
        }
    }

    #[test]
    fn database_admission_conflict_payload() {
        for message in [
            DATABASE_OPEN_THROUGH_ANOTHER_DIRECTORY,
            DATABASE_OPEN_THROUGH_ANOTHER_NAME,
        ] {
            let error = Error::Conflict(message.into());
            let payload = serde_json::to_value(&error).expect("database admission payload");
            assert_eq!(payload["category"], "conflict");
            assert_eq!(payload["message"], format!("Conflict: {message}"));
            assert_eq!(payload["databaseAdmission"], true);
            assert!(payload.get("nameTaken").is_none());

            for error in [
                Error::Conflict(format!("{message} elsewhere")),
                Error::InvalidInput(message.into()),
                Error::Shared(std::sync::Arc::new(Error::Conflict(message.into()))),
                Error::Conflict(message.into()).with_root_failure(RootFailure::Changed),
                Error::with_cleanup(
                    Error::Conflict(message.into()),
                    Err(Error::InvalidInput("cleanup failed".into())),
                ),
            ] {
                let payload = serde_json::to_value(error).expect("other payload");
                assert!(payload.get("databaseAdmission").is_none());
                assert!(payload.get("nameTaken").is_none());
            }
        }

        let error = Error::Conflict(WORKSPACE_FILE_NAME_TAKEN.into());
        let payload = serde_json::to_value(&error).expect("name-taken payload");
        assert_eq!(payload["nameTaken"], true);
        assert!(payload.get("databaseAdmission").is_none());

        for message in [
            "bound SQLite registry was poisoned",
            "file is open through a SQLite binding",
            "database changed after capability resolution",
        ] {
            let payload =
                serde_json::to_value(Error::Conflict(message.into())).expect("other payload");
            assert!(payload.get("databaseAdmission").is_none());
            assert!(payload.get("nameTaken").is_none());
        }
    }

    #[test]
    fn engine_failure_tag_preserves_optional_snapshot_and_native_cleanup_diagnostics() {
        let snapshot = crate::engine::EngineTerminalSnapshot {
            kind: crate::engine::EngineFailureKind::ProtocolFailure,
            exit_status: None,
            reason: Some("command e2e4 rejected".into()),
            entries: vec![crate::engine::EngineTerminalEntry::InfoString(
                "command e2e4 rejected".into(),
            )],
        };
        let failure = Error::EngineFailure {
            snapshot: Some(Box::new(snapshot.clone())),
            cause: Box::new(Error::Io(Box::new(std::io::Error::other(
                "/private/primary token=hidden",
            )))),
            cleanup: None,
        };
        let error = Error::with_cleanup(
            Error::Shared(std::sync::Arc::new(failure)),
            Err(Error::Io(Box::new(std::io::Error::other(
                "/private/cleanup password=hidden2",
            )))),
        );
        let error = cancelled_search_error(error, true);
        assert_eq!(error.category(), ErrorCategory::OperationAndCleanup);
        assert!(error.to_string().contains("cleanup also failed"));
        assert_eq!(error.engine_failure_snapshot(), Some(&snapshot));
        assert!(error.diagnostic().contains("/private/primary"));
        assert!(error.diagnostic().contains("/private/cleanup"));
        let bytes = serde_json::to_string(&error).unwrap();
        let payload: serde_json::Value = serde_json::from_str(&bytes).unwrap();
        assert_eq!(payload["tag"], "engine-failure");
        assert_eq!(payload["engineFailure"]["reason"], "command e2e4 rejected");
        assert!(!bytes.contains("private"));
        assert!(!bytes.contains("hidden"));

        let error = Error::EngineFailure {
            snapshot: None,
            cause: Box::new(Error::EngineDisconnected),
            cleanup: None,
        };
        let payload: serde_json::Value =
            serde_json::from_str(&serde_json::to_string(&error).unwrap()).unwrap();
        assert_eq!(payload["tag"], "engine-failure");
        assert_eq!(payload["category"], "engine-failure");
        assert!(payload.get("engineFailure").is_none());
    }
    #[test]
    fn committed_removal_retains_native_cause_and_sanitizes_wire_message() {
        for cause in [
            Error::Io(Box::new(std::io::Error::other(
                r"/private/registry C:\private\registry",
            ))),
            Error::EngineTimeout(r"/private/engine C:\private\engine".into()),
        ] {
            let diagnostic = cause.diagnostic();
            let category = cause.category();
            let error = CommittedRemoval::new(4, Some(cause))
                .finish()
                .expect_err("post-commit failure");
            let payload = serde_json::to_string(&error).expect("wire payload");
            assert_eq!(
                serde_json::from_str::<serde_json::Value>(&payload).unwrap()["category"],
                "partial-removal"
            );
            assert!(!payload.contains("/private/"));
            assert!(!payload.contains(r"C:\\private"));
            assert!(
                matches!(error, Error::PartialRemoval { removed_entries: 4, cause }
                if cause.category() == category && cause.diagnostic() == diagnostic)
            );
        }
    }

    #[test]
    fn committed_removal_succeeds_without_failure() {
        let mut removal = CommittedRemoval::new(1, None);
        removal.record(Ok(()), "test cleanup", std::path::Path::new("database.db3"));
        assert!(removal.finish().is_ok());
    }

    #[test]
    fn committed_removal_wraps_initial_hard_failure() {
        let error = CommittedRemoval::new(2, Some(Error::Conflict("first hard failure".into())))
            .finish()
            .unwrap_err();
        assert_eq!(
            serde_json::to_value(&error).unwrap()["category"],
            "partial-removal"
        );
        assert!(
            matches!(error, Error::PartialRemoval { removed_entries: 2, cause }
            if matches!(*cause, Error::Conflict(ref message) if message == "first hard failure"))
        );
    }

    #[test]
    fn committed_removal_records_first_failure_and_counts_later_entries() {
        let mut removal = CommittedRemoval::new(1, None);
        removal.record(
            Err(Error::Conflict("first recorded failure".into())),
            "test cleanup",
            std::path::Path::new("database.db3"),
        );
        removal.add_removed_entries(2);
        removal.record(Ok(()), "test cleanup", std::path::Path::new("database.db3"));
        let error = removal.finish().unwrap_err();
        assert_eq!(
            serde_json::to_value(&error).unwrap()["category"],
            "partial-removal"
        );
        assert!(
            matches!(error, Error::PartialRemoval { removed_entries: 3, cause }
            if matches!(*cause, Error::Conflict(ref message) if message == "first recorded failure"))
        );
    }

    #[test]
    fn committed_removal_preserves_durability_uncertainty() {
        let error = CommittedRemoval::new(
            1,
            Some(Error::CommittedDurabilityUncertain(
                DurabilityStage::RegistryReplacement,
            )),
        )
        .finish()
        .unwrap_err();
        assert_eq!(
            serde_json::to_value(&error).unwrap()["category"],
            "durability"
        );
        assert!(matches!(
            error,
            Error::CommittedDurabilityUncertain(DurabilityStage::RegistryReplacement)
        ));
    }

    #[test]
    fn committed_removal_keeps_durability_before_hard_failure_and_logs_diagnostic() {
        let capture = LogCaptureScope::start();
        let mut removal = CommittedRemoval::new(
            1,
            Some(Error::CommittedDurabilityUncertain(
                DurabilityStage::WorkspaceRemoval,
            )),
        );
        removal.record(
            Err(Error::from(std::io::Error::other("later native failure"))),
            "test sidecar removal",
            std::path::Path::new("database.db3"),
        );
        let error = removal.finish().unwrap_err();
        assert_eq!(
            serde_json::to_value(&error).unwrap()["category"],
            "durability"
        );
        assert!(matches!(
            error,
            Error::CommittedDurabilityUncertain(DurabilityStage::WorkspaceRemoval)
        ));
        assert!(capture
            .records()
            .iter()
            .any(|record| record.level == log::Level::Warn
                && record.message.contains("test sidecar removal")
                && record.message.contains("database.db3")
                && record.message.contains("kept category: Durability")
                && record.message.contains("I/O failure: later native failure")));
    }

    #[test]
    fn committed_removal_keeps_hard_failure_before_durability_and_logs_it() {
        let capture = LogCaptureScope::start();
        let mut removal =
            CommittedRemoval::new(1, Some(Error::Conflict("first hard failure".into())));
        let later = Error::CommittedDurabilityUncertain(DurabilityStage::RegistryReplacement);
        let diagnostic = later.diagnostic();
        removal.record(
            Err(later),
            "test registry cleanup",
            std::path::Path::new("database.db3"),
        );
        let error = removal.finish().unwrap_err();
        assert_eq!(
            serde_json::to_value(&error).unwrap()["category"],
            "partial-removal"
        );
        assert!(
            matches!(error, Error::PartialRemoval { removed_entries: 1, cause }
            if matches!(*cause, Error::Conflict(ref message) if message == "first hard failure"))
        );
        assert!(capture
            .records()
            .iter()
            .any(|record| record.level == log::Level::Warn
                && record.message.contains("test registry cleanup")
                && record.message.contains("database.db3")
                && record.message.contains("kept category: Conflict")
                && record.message.contains(&diagnostic)));
    }

    #[test]
    fn shared_error_preserves_all_observable_surfaces() {
        let errors = [
            Error::Io(Box::new(std::io::Error::other("shared I/O sentinel"))),
            Error::EngineTimeout("shared timeout sentinel".into()),
            Error::OperationAndCleanup {
                primary: "shared primary sentinel".into(),
                cleanup: "shared cleanup sentinel".into(),
            },
            Error::Io(Box::new(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "shared root sentinel",
            )))
            .with_root_failure(RootFailure::Missing),
        ];
        for original in errors {
            let original = std::sync::Arc::new(original);
            let shared = Error::Shared(original.clone());
            assert_eq!(shared.category(), original.category());
            assert_eq!(shared.to_string(), original.to_string());
            assert_eq!(shared.diagnostic(), original.diagnostic());
            assert_eq!(shared.root_failure(), original.root_failure());
            assert_eq!(
                serde_json::to_value(&shared).unwrap(),
                serde_json::to_value(&*original).unwrap()
            );
            let original_source = std::error::Error::source(&*original);
            let shared_source = std::error::Error::source(&shared);
            assert_eq!(
                shared_source.map(ToString::to_string),
                original_source.map(ToString::to_string)
            );
            if let (Some(shared_source), Some(original_source)) = (shared_source, original_source) {
                assert!(std::ptr::eq(shared_source, original_source));
            }
        }
    }

    #[test]
    fn is_sqlite_notadb_diesel_code_26() {
        let error = Error::Diesel(Box::new(diesel::result::Error::DatabaseError(
            diesel::result::DatabaseErrorKind::Unknown,
            Box::new("26".to_string()),
        )));
        assert!(is_sqlite_notadb(&error));
    }

    #[test]
    fn is_sqlite_notadb_diesel_message() {
        let error = Error::Diesel(Box::new(diesel::result::Error::DatabaseError(
            diesel::result::DatabaseErrorKind::Unknown,
            Box::new("file is not a database".to_string()),
        )));
        assert!(is_sqlite_notadb(&error));
        assert!(!is_sqlite_notadb(&Error::Conflict("not a database".into())));
        assert!(!is_sqlite_notadb(&Error::InvalidInput(
            "DataRevision is not a non-negative i64".into(),
        )));
        assert!(!is_sqlite_notadb(&Error::InvalidInput(
            "DataRevision overflow".into(),
        )));
        assert!(!is_sqlite_notadb(&Error::Cancellation));
        assert!(!is_sqlite_notadb(&Error::Io(Box::new(
            std::io::Error::other("I/O failure",)
        ))));
        let busy = Error::Diesel(Box::new(diesel::result::Error::DatabaseError(
            diesel::result::DatabaseErrorKind::Unknown,
            Box::new("database is locked".to_string()),
        )));
        assert!(!is_sqlite_notadb(&busy));
    }

    fn parsed_payload(serialized: &str) -> serde_json::Value {
        let payload: serde_json::Value =
            serde_json::from_str(serialized).expect("serialized error must be a JSON object");
        // The discriminant is what lets the renderer tell an ErrorPayload from its own AppError,
        // which is the same JSON shape and shares the values `network` and `permission`
        // (`d-PENDING`, D-I). Asserting it here rather than in one test covers every serialize
        // test at once: without it, dropping `tag` from the wire leaves the whole suite green
        // while `isErrorPayload` never matches in production.
        assert_eq!(
            payload["tag"], "backend-error",
            "every serialized Error must carry the wire discriminant"
        );
        payload
    }

    #[test]
    fn sqlite_establish_serializes_fixed_message_and_logs_native_cause() {
        const NATIVE_CAUSE: &str = "/private/sqlite-database: native OS diagnostic";
        let capture = LogCaptureScope::start();
        let error =
            map_sqlite_establish(diesel::ConnectionError::BadConnection(NATIVE_CAUSE.into()));
        let Error::Io(source) = &error else {
            panic!("host open failure must remain an I/O failure: {error:?}");
        };
        assert_eq!(source.kind(), std::io::ErrorKind::Other);
        assert_eq!(source.raw_os_error(), None);
        assert!(matches!(
            source.get_ref().unwrap().downcast_ref::<diesel::ConnectionError>(),
            Some(diesel::ConnectionError::BadConnection(message)) if message == NATIVE_CAUSE
        ));
        assert!(error.diagnostic().contains(NATIVE_CAUSE));
        let serialized = serde_json::to_string(&error).unwrap();
        let payload = parsed_payload(&serialized);
        assert_eq!(payload["category"], "io");
        assert_eq!(payload["message"], "I/O failure");
        for native_fragment in NATIVE_CAUSE.split_whitespace() {
            assert!(!serialized.contains(native_fragment));
        }
        assert!(capture.records().iter().any(|record| {
            record.level == log::Level::Warn && record.message.contains(NATIVE_CAUSE)
        }));
    }

    #[test]
    fn sqlite_establish_bad_connection_does_not_infer_os_error_from_messages() {
        for message in [
            "unable to open database file",
            "permission denied",
            "too many open files",
        ] {
            let error =
                map_sqlite_establish(diesel::ConnectionError::BadConnection(message.into()));
            let Error::Io(source) = &error else {
                panic!("host open failure must remain an I/O failure: {error:?}");
            };
            assert_eq!(source.kind(), std::io::ErrorKind::Other);
            assert_eq!(source.raw_os_error(), None);
            assert!(error.diagnostic().contains(message));
            let payload = parsed_payload(&serde_json::to_string(&error).unwrap());
            assert_eq!(payload["category"], "io");
            assert_eq!(payload["message"], "I/O failure");
        }
    }

    #[test]
    fn sqlite_establish_keeps_recognized_notadb_as_invalid_input() {
        for message in ["file is not a database", "SQLITE_NOTADB", "code: 26"] {
            for original in [
                diesel::ConnectionError::BadConnection(message.into()),
                diesel::ConnectionError::CouldntSetupConfiguration(
                    diesel::result::Error::DatabaseError(
                        diesel::result::DatabaseErrorKind::Unknown,
                        Box::new(message.to_owned()),
                    ),
                ),
            ] {
                let error = map_sqlite_establish(original);
                assert!(matches!(
                    &error,
                    Error::InvalidInput(message) if message == "SQLite file is not a database"
                ));
                assert!(is_sqlite_notadb(&error));
                let payload = parsed_payload(&serde_json::to_string(&error).unwrap());
                assert_eq!(payload["category"], "invalid-input");
                assert_eq!(
                    payload["message"],
                    "Invalid input: SQLite file is not a database"
                );
            }
        }
    }

    #[test]
    fn sqlite_establish_typed_invalid_configuration_has_a_safe_validation_payload() {
        let nul_error = std::ffi::CString::new("/private/database\0.db3").unwrap_err();
        for original in [
            diesel::ConnectionError::InvalidCString(nul_error),
            diesel::ConnectionError::InvalidConnectionUrl("/private/invalid-url".into()),
        ] {
            let native_cause = original.to_string();
            let capture = LogCaptureScope::start();
            let error = map_sqlite_establish(original);
            assert!(matches!(
                &error,
                Error::InvalidInput(message) if message == "could not open SQLite database"
            ));
            let payload = parsed_payload(&serde_json::to_string(&error).unwrap());
            assert_eq!(payload["category"], "invalid-input");
            assert_eq!(
                payload["message"],
                "Invalid input: could not open SQLite database"
            );
            assert!(capture.records().iter().any(|record| {
                record.level == log::Level::Warn && record.message.contains(&native_cause)
            }));
        }
    }

    #[test]
    fn sqlite_establish_configuration_query_failure_retains_typed_native_cause() {
        let originals = [
            diesel::result::Error::DatabaseError(
                diesel::result::DatabaseErrorKind::UnableToSendCommand,
                Box::new("/private/database: configuration query failed".to_owned()),
            ),
            diesel::result::Error::NotFound,
        ];
        for original in originals {
            let native_cause = original.to_string();
            let capture = LogCaptureScope::start();
            let error =
                map_sqlite_establish(diesel::ConnectionError::CouldntSetupConfiguration(original));
            let Error::Diesel(source) = &error else {
                panic!("configuration query failure must retain its Diesel error: {error:?}");
            };
            match source.as_ref() {
                diesel::result::Error::DatabaseError(kind, information) => {
                    assert!(matches!(
                        kind,
                        diesel::result::DatabaseErrorKind::UnableToSendCommand
                    ));
                    assert_eq!(information.message(), native_cause);
                }
                diesel::result::Error::NotFound => assert_eq!(native_cause, "Record not found"),
                other => panic!("configuration query failure changed type: {other:?}"),
            }
            assert!(error.diagnostic().contains(&native_cause));
            let payload = parsed_payload(&serde_json::to_string(&error).unwrap());
            assert_eq!(payload["category"], "database");
            assert_eq!(payload["message"], "database failure");
            assert!(capture.records().iter().any(|record| {
                record.level == log::Level::Warn && record.message.contains(&native_cause)
            }));
        }
    }

    #[test]
    fn reqwest_serializes_as_network_failure() {
        let reqwest_error = reqwest::Client::new()
            .get("http://[")
            .build()
            .expect_err("invalid URL must fail request construction");
        let serialized = serde_json::to_string(&Error::from(reqwest_error)).unwrap();
        let payload = parsed_payload(&serialized);
        assert_eq!(payload["category"], "network");
        assert_eq!(payload["message"], "network failure");
        assert!(!serialized.contains("http"));
    }

    #[test]
    fn remote_http_rejection_contract_preserves_only_safe_facts() {
        for status in (100..600).filter(|status| !(200..300).contains(status)) {
            let category = match status {
                401 => "authentication",
                403 => "permission",
                404 => "missing-resource",
                _ => "network",
            };
            for authorization_sent in [false, true] {
                let detail = RemoteHttpRejection {
                    status,
                    authorization_sent,
                };
                let error = Error::RemoteHttpRejection(detail);
                let message = format!("Remote HTTP request rejected: status {status}");
                assert_eq!(error.to_string(), message);
                assert_eq!(error.diagnostic(), message);
                let expected = serde_json::json!({
                    "tag": "backend-error",
                    "category": category,
                    "message": message,
                    "remoteHttpRejection": {"status": status, "authorizationSent": authorization_sent}
                });
                assert_eq!(serde_json::to_value(&error).unwrap(), expected);
                let shared = Error::Shared(std::sync::Arc::new(error));
                assert_eq!(serde_json::to_value(&shared).unwrap(), expected);
                let labelled = shared.with_root_failure(RootFailure::Unusable);
                let mut labelled_expected = expected;
                labelled_expected["rootFailure"] = serde_json::json!("unusable");
                assert_eq!(serde_json::to_value(&labelled).unwrap(), labelled_expected);
                assert_eq!(labelled.diagnostic(), message);
            }
        }
    }

    #[test]
    fn remote_http_rejection_detail_is_absent_for_other_and_combined_errors() {
        let remote = || {
            Error::RemoteHttpRejection(RemoteHttpRejection {
                status: 401,
                authorization_sent: true,
            })
        };
        for error in [
            Error::InvalidInput("example".into()),
            Error::Cancellation,
            Error::EngineRetired,
            Error::with_cleanup(remote(), Err(Error::Cancellation)),
            Error::with_cleanup(Error::Cancellation, Err(remote())),
        ] {
            let payload = serde_json::to_value(&error).unwrap();
            assert!(payload.get("remoteHttpRejection").is_none());
            if matches!(error, Error::OperationAndCleanup { .. }) {
                assert_eq!(payload["category"], "operation-and-cleanup");
            }
        }
    }

    #[test]
    fn test_committed_durability_uncertain_mapping() {
        let err = Error::CommittedDurabilityUncertain(DurabilityStage::RegistryReplacement);
        assert_eq!(
            err.to_string(),
            "Committed but durability uncertain: registry replacement"
        );
        let directory =
            Error::CommittedDurabilityUncertain(DurabilityStage::WorkspaceDirectoryCreation);
        assert_eq!(
            directory.to_string(),
            "Committed but durability uncertain: workspace directory creation"
        );
    }

    #[test]
    fn test_cancellation_display() {
        assert_eq!(Error::Cancellation.to_string(), "Cancellation");
    }

    #[test]
    fn every_durability_label_serializes_without_native_diagnostics() {
        // An unlisted durability stage fails to compile.
        macro_rules! durability_stages {
            ($($variant:ident),* $(,)?) => {{
                let _exhaustive = |stage: DurabilityStage| match stage {
                    $(DurabilityStage::$variant)|* => (),
                };
                [$(DurabilityStage::$variant),*]
            }};
        }
        let stages = durability_stages![
            ArchiveCommitMarker,
            ArchiveReservationJournal,
            DatabasePgnReplacement,
            DirectoryInstall,
            DownloadTargetReplacement,
            NativeExport,
            OldDirectoryCleanup,
            OldDirectoryCleanupSync,
            PgnEdit,
            PgnCacheInvalidation,
            CollectionIndexRefresh,
            PgnCapabilityRebind,
            RegistryReplacement,
            SearchIndexReplacement,
            WorkspaceDirectoryCreation,
            WorkspacePgnCreation,
            WorkspaceRemoval,
            WorkspaceRename,
            WorkspaceSidecarCreation,
            WorkspaceSidecarReplacement,
            PracticePositions,
            PracticeReviewShard,
            PracticeState,
        ];
        for stage in stages {
            let error = Error::CommittedDurabilityUncertain(stage);
            let serialized = serde_json::to_string(&error).expect("serialize durability error");
            let payload = parsed_payload(&serialized);
            assert_eq!(payload["category"], "durability");
            assert_eq!(payload["message"], error.to_string());
            if stage == DurabilityStage::WorkspaceDirectoryCreation {
                assert_eq!(
                    payload["message"],
                    "Committed but durability uncertain: workspace directory creation"
                );
            }
            assert!(!serialized.contains("/private/producer"));
            assert!(!serialized.contains(r"C:\producer"));
            assert!(!serialized.contains("raw operating system failure"));
        }
    }

    #[test]
    fn operation_and_cleanup_serialization_omits_both_diagnostics() {
        let error = Error::OperationAndCleanup {
            primary: "/private/producer: raw operating system failure".into(),
            cleanup: r"C:\producer: access denied".into(),
        };
        let serialized = serde_json::to_string(&error).expect("serialize cleanup error");
        let payload = parsed_payload(&serialized);
        assert_eq!(payload["category"], "operation-and-cleanup");
        assert_eq!(
            payload["message"],
            "Operation failed; temporary cleanup also failed"
        );
    }

    #[tokio::test]
    async fn retained_cleanup_shared_join_conversion_omits_private_panic_marker() {
        let capture = LogCaptureScope::start();
        const MARKER: &str = "/private/error-join-marker";
        let join = tokio::spawn(async { panic!("{MARKER}") })
            .await
            .unwrap_err();
        let error = Error::task_join("task join failed", &join, "error serialization test");
        assert_eq!(error.category(), ErrorCategory::Conflict);
        assert!(!serde_json::to_string(&error).unwrap().contains(MARKER));
        let composite = Error::with_cleanup(error, Err(Error::Cancellation));
        assert!(!serde_json::to_string(&composite).unwrap().contains(MARKER));
        assert!(capture.records().iter().any(|record| {
            record.level == log::Level::Error
                && record
                    .message
                    .contains("task join failed owner=error serialization test")
                && record.message.contains(MARKER)
        }));
    }

    #[test]
    fn diagnostic_with_cleanup_preserves_both_io_causes() {
        const PRIMARY: &str = "diagnostic-primary-io-cause";
        const CLEANUP: &str = "diagnostic-cleanup-io-cause";
        let primary = Error::from(std::io::Error::other(PRIMARY));
        let cleanup = Error::from(std::io::Error::other(CLEANUP));
        let primary_diagnostic = primary.diagnostic();
        let cleanup_diagnostic = cleanup.diagnostic();

        let error = Error::with_cleanup(primary, Err(cleanup));
        match &error {
            Error::OperationAndCleanup { primary, cleanup } => {
                assert_eq!(primary, &primary_diagnostic);
                assert_eq!(cleanup, &cleanup_diagnostic);
                assert!(primary.contains(PRIMARY));
                assert!(cleanup.contains(CLEANUP));
            }
            other => panic!("expected combined cleanup error, got {other:?}"),
        }
        assert_eq!(
            error.diagnostic(),
            format!("primary={primary_diagnostic}; cleanup={cleanup_diagnostic}")
        );

        let unchanged = Error::with_cleanup(Error::Cancellation, Ok(()));
        assert!(matches!(unchanged, Error::Cancellation));
    }

    #[test]
    fn diagnostic_reqwest_preserves_builder_cause_without_changing_payload() {
        const URL: &str = "file:///diagnostic-reqwest-url-marker/catalog.json";
        let reqwest_error = reqwest::Client::new()
            .get(URL)
            .build()
            .expect_err("file URL must fail request construction without sending a request");
        assert!(reqwest_error.is_builder());
        let native_message = reqwest_error.to_string();
        assert!(native_message.contains(URL));
        let native_cause = std::error::Error::source(&reqwest_error)
            .expect("builder error must retain its native cause")
            .to_string();
        assert_eq!(native_cause, "URL scheme is not allowed");

        let error = Error::from(reqwest_error);
        let diagnostic = error.diagnostic();
        assert!(diagnostic.contains(&native_message));
        assert!(diagnostic.contains(&native_cause));
        assert_eq!(error.to_string(), "network failure");
        assert_eq!(error.category(), ErrorCategory::Network);
        let serialized = serde_json::to_string(&error).expect("serialize network error");
        let payload = parsed_payload(&serialized);
        assert_eq!(
            payload,
            serde_json::json!({
                "tag": "backend-error",
                "category": "network",
                "message": "network failure"
            })
        );
        assert!(!serialized.contains(URL));
        assert!(!serialized.contains(&native_cause));
    }

    #[test]
    fn diagnostic_transparent_parse_text_appears_once() {
        let error: Error = "not-an-integer".parse::<u64>().unwrap_err().into();
        let display = error.to_string();

        assert_eq!(error.diagnostic(), display);
        assert_eq!(error.diagnostic().matches(&display).count(), 1);
    }

    #[test]
    fn diagnostic_skips_a_source_already_in_the_outer_source_text() {
        const INNER: &str = "diagnostic-source-chain-unique-inner";

        #[derive(Debug)]
        struct Inner;

        impl std::fmt::Display for Inner {
            fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str(INNER)
            }
        }

        impl std::error::Error for Inner {}

        #[derive(Debug)]
        struct Outer(Inner);

        impl std::fmt::Display for Outer {
            fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                write!(formatter, "outer-context: {}", self.0)
            }
        }

        impl std::error::Error for Outer {
            fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
                Some(&self.0)
            }
        }

        let error = Error::from(std::io::Error::other(Outer(Inner)));
        assert_eq!(
            error.diagnostic(),
            format!("I/O failure: outer-context: {INNER}")
        );
    }

    #[cfg(unix)]
    #[test]
    fn durability_producer_logs_native_cause() {
        let capture = LogCaptureScope::start();
        const CAUSE: &str = "/private/durability-log-test: native cause";

        struct ResetAtomicInjector;
        impl Drop for ResetAtomicInjector {
            fn drop(&mut self) {
                crate::infra::fs::set_test_atomic_file_injector(None);
            }
        }

        let directory = tempfile::tempdir().expect("durability log directory");
        let root = directory.path().join("root");
        std::fs::create_dir(&root).expect("durability log root");
        let mut authority = crate::infra::path_authority::PathAuthority::open(
            directory.path().join("registry.json"),
            vec![],
        )
        .expect("path authority");
        crate::infra::fs::set_test_atomic_file_injector(Some(std::sync::Arc::new(
            crate::infra::fs::ParentSyncFault(CAUSE),
        )));
        let _reset = ResetAtomicInjector;
        let commit = authority
            .migrate_legacy_os_path(
                root.into_os_string(),
                "durability log root",
                crate::infra::path_authority::PathClass::PersistentCustomRoot,
                vec![crate::infra::path_authority::PathOperation::DownloadFile],
            )
            .expect("registry commit");

        assert!(matches!(
            commit.durability,
            crate::infra::path_authority::CommitDurability::DurabilityUncertain(
                DurabilityStage::RegistryReplacement
            )
        ));
        assert!(capture
            .messages()
            .iter()
            .any(|message| message.contains(CAUSE)));
    }

    #[test]
    fn partial_removal_diagnostic_keeps_cause_without_changing_payload() {
        let err = Error::PartialRemoval {
            removed_entries: 1,
            cause: Box::new(Error::Conflict("path authority lock was poisoned".into())),
        };
        assert!(err
            .diagnostic()
            .contains("path authority lock was poisoned"));
        assert_eq!(
            err.to_string(),
            "Partially removed: 1 entries were deleted before failing: conflict"
        );
        assert_eq!(err.category(), ErrorCategory::PartialRemoval);
        let payload = serde_json::to_value(&err).expect("serialize error");
        assert_eq!(
            payload["message"],
            "Partially removed: 1 entries were deleted before failing: conflict"
        );
        assert_eq!(payload["category"], "partial-removal");
    }

    #[test]
    fn partial_removal_serialization_retains_only_the_typed_cause_category() {
        let err = Error::PartialRemoval {
            removed_entries: 2,
            cause: Box::new(Error::from(std::io::Error::other(
                "/private/root: raw operating system failure",
            ))),
        };
        assert!(matches!(
            err,
            Error::PartialRemoval {
                cause,
                ..
            } if matches!(*cause, Error::Io(_))
        ));

        let err = Error::PartialRemoval {
            removed_entries: 2,
            cause: Box::new(Error::from(std::io::Error::other(
                "/private/root: raw operating system failure",
            ))),
        };
        let serialized = serde_json::to_string(&err).expect("serialize error");
        let payload = parsed_payload(&serialized);
        assert_eq!(payload["category"], "partial-removal");
        assert_eq!(
            payload["message"],
            "Partially removed: 2 entries were deleted before failing: I/O failure"
        );
    }

    #[test]
    fn engine_timeout_serializes_as_engine_timeout_category() {
        let serialized =
            serde_json::to_string(&Error::EngineTimeout("waiting for readyok".into())).unwrap();
        let payload = parsed_payload(&serialized);
        assert_eq!(payload["category"], "engine-timeout");
    }

    #[test]
    fn engine_retirement_serializes_distinctly_and_keeps_cleanup_failures() {
        let retired = parsed_payload(&serde_json::to_string(&Error::EngineRetired).unwrap());
        assert_eq!(retired["tag"], "backend-error");
        assert_eq!(retired["category"], "engine-retired");
        assert_eq!(retired["message"], "Engine id is retired");
        for error in [Error::Cancellation, Error::AnalysisCancelled] {
            let payload = parsed_payload(&serde_json::to_string(&error).unwrap());
            assert_eq!(payload["category"], "cancellation");
        }
        let combined = Error::with_cleanup(
            Error::EngineRetired,
            Err(std::io::Error::other("retirement cleanup failed").into()),
        );
        let payload = parsed_payload(&serde_json::to_string(&combined).unwrap());
        assert_eq!(payload["category"], "operation-and-cleanup");
        assert!(combined.diagnostic().contains("Engine id is retired"));
        assert!(combined.diagnostic().contains("retirement cleanup failed"));
    }

    #[test]
    fn analysis_cancelled_serializes_as_cancellation_category() {
        let serialized = serde_json::to_string(&Error::AnalysisCancelled).unwrap();
        let payload = parsed_payload(&serialized);
        assert_eq!(payload["category"], "cancellation");
    }

    #[test]
    fn io_not_found_serializes_as_missing_resource_without_path() {
        let serialized = serde_json::to_string(&Error::from(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "/private/secret",
        )))
        .unwrap();
        let payload = parsed_payload(&serialized);
        assert_eq!(payload["category"], "missing-resource");
        assert_eq!(payload["message"], "I/O failure");
        assert!(!serialized.contains("/private/secret"));
    }

    #[test]
    fn io_permission_denied_serializes_as_permission_without_path() {
        let serialized = serde_json::to_string(&Error::from(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "/private/secret",
        )))
        .unwrap();
        let payload = parsed_payload(&serialized);
        assert_eq!(payload["category"], "permission");
        assert!(!serialized.contains("/private/secret"));
    }

    #[test]
    fn io_other_serializes_as_io_category() {
        let serialized =
            serde_json::to_string(&Error::from(std::io::Error::other("unclassified"))).unwrap();
        let payload = parsed_payload(&serialized);
        assert_eq!(payload["category"], "io");
    }

    #[test]
    fn invalid_input_serializes_the_owned_message() {
        let serialized = serde_json::to_string(&Error::InvalidInput(
            "no window labeled 'main' found".into(),
        ))
        .unwrap();
        let payload = parsed_payload(&serialized);
        assert_eq!(payload["category"], "invalid-input");
        assert_eq!(
            payload["message"],
            "Invalid input: no window labeled 'main' found"
        );
    }

    #[test]
    fn stale_game_serializes_as_stale_game_category() {
        let serialized = serde_json::to_string(&Error::StaleGame).expect("serialize stale game");
        let payload = parsed_payload(&serialized);
        assert_eq!(payload["category"], "stale-game");
    }

    #[test]
    fn opaque_foreign_variants_omit_the_cause_from_the_payload_and_keep_it_on_source() {
        let r2d2_error = r2d2_timeout_error();
        assert!(r2d2_error
            .to_string()
            .contains("timed out waiting for connection"));
        let cases: [(&str, Error, &str, &str, &str); 6] = [
            (
                "io",
                Error::from(std::io::Error::other("unique-io-marker")),
                "unique-io-marker",
                "I/O failure",
                "io",
            ),
            (
                "zip",
                Error::from(zip::result::ZipError::InvalidArchive("unique-zip-marker")),
                "unique-zip-marker",
                "parsing failure",
                "parsing",
            ),
            (
                "tauri",
                Error::from(tauri::Error::AssetNotFound(
                    "/private/secret-tauri-asset".into(),
                )),
                "/private/secret-tauri-asset",
                "platform failure",
                "platform",
            ),
            (
                "tauri-opener",
                Error::from(tauri_plugin_opener::Error::UnknownProgramName(
                    "secret-opener-program".into(),
                )),
                "secret-opener-program",
                "platform failure",
                "platform",
            ),
            (
                "diesel",
                Error::from(diesel::result::Error::DatabaseError(
                    diesel::result::DatabaseErrorKind::Unknown,
                    Box::new("SELECT * FROM secret_diesel_table".to_string()),
                )),
                "SELECT * FROM secret_diesel_table",
                "database failure",
                "database",
            ),
            (
                "r2d2",
                Error::from(r2d2_error),
                "timed out waiting for connection",
                "database failure",
                "database",
            ),
        ];
        for (label, error, marker, message, category) in cases {
            let serialized = serde_json::to_string(&error).expect("serialize opaque variant");
            let payload = parsed_payload(&serialized);
            assert_eq!(payload["message"], message, "{label} message");
            // Pin the category per variant, not only the Display. Without this, regrouping a
            // variant into another `category()` arm leaves this test and every renderer
            // BACKEND_CATEGORY row green -- those rows feed hand-built categories, never a
            // serialized Zip or Diesel -- and ConfirmModal then interpolates the wrong key.
            assert_eq!(payload["category"], category, "{label} category");
            assert!(
                !serialized.contains(marker),
                "{label} leaked foreign display {marker:?} in {serialized}"
            );
            let source = std::error::Error::source(&error)
                .unwrap_or_else(|| panic!("{label} must keep its cause on source()"));
            let source_text = source.to_string();
            assert!(
                source_text.contains(marker),
                "{label} source {source_text} did not contain {marker}"
            );
        }
    }

    fn r2d2_timeout_error() -> diesel::r2d2::PoolError {
        let directory = tempfile::tempdir().expect("r2d2 leak tempdir");
        let path = directory.path().join("r2d2-leak.db");
        let manager = diesel::r2d2::ConnectionManager::<diesel::SqliteConnection>::new(
            path.to_string_lossy().into_owned(),
        );
        let pool = diesel::r2d2::Pool::builder()
            .max_size(1)
            .connection_timeout(std::time::Duration::from_millis(50))
            .build(manager)
            .expect("r2d2 pool");
        let _held = pool.get().expect("hold the only connection");
        match pool.get() {
            Err(error) => error,
            Ok(_) => panic!("exhausted pool times out"),
        }
    }

    #[test]
    fn serialize_emits_no_log_record_of_the_native_cause() {
        let capture = LogCaptureScope::start();
        const MARKER: &str = "/private/serialize-no-log-marker-f20260830";
        let error = Error::from(std::io::Error::other(MARKER));
        let _serialized = serde_json::to_string(&error).expect("serialize error");
        assert!(
            capture
                .messages()
                .iter()
                .all(|message| !message.contains(MARKER)),
            "serializing Error must not log the native cause"
        );
    }

    #[test]
    fn credential_failure_serialization_omits_the_keyring_string() {
        let error = Error::CredentialFailure("/private/keyring-secret-token".into());
        let serialized = serde_json::to_string(&error).expect("serialize credential error");
        let payload = parsed_payload(&serialized);
        assert_eq!(payload["category"], "credential");
        assert_eq!(payload["message"], "Credential operation failed");
        assert!(!serialized.contains("/private/keyring-secret-token"));
        assert!(!serialized.contains("keyring-secret-token"));
    }
}
