#[cfg(test)]
use crate::infra::path_authority::PathAuthority;
use std::{
    collections::{HashSet, VecDeque},
    hash::Hash,
    process::Stdio,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex as StdMutex, OnceLock,
    },
    time::Duration,
};

use async_trait::async_trait;
use dashmap::DashMap;
use futures_util::{
    future::{BoxFuture, Shared},
    FutureExt,
};
use log::error;
use serde::Serialize;
use specta::Type;
use tokio::sync::{mpsc, oneshot, Mutex, Notify, OwnedSemaphorePermit, Semaphore};
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
    time::{timeout, timeout_at, Instant},
};
use tokio_util::sync::CancellationToken;
use vampirc_uci::UciMessage;

#[cfg(all(test, unix))]
use std::collections::HashMap;

use crate::error::{cancelled_search_error, Error};
use crate::infra::{
    blocking::{BlockingGateway, BLOCKING_GATEWAY},
    keyed_locks::{KeyedLockLease, KeyedLocks},
    path_authority::{EngineExecutable, EngineHandle, PathOperation, PathRef},
};

use super::{
    canonicalize_engine_position,
    types::{
        resolve_engine_option_leases, validate_uci_text, EngineDeadlines, EngineExitStatus,
        EngineFailureKind, EngineKey, EngineOption, EngineRequestId, EngineState,
        EngineTerminalEntry, EngineTerminalSnapshot, GoMode, ResolvedEngineOption,
    },
    GAME_ENGINE_KEY_PREFIX,
};
const MAX_LOG_LINES: usize = 2_000;
const MAX_LOG_BYTES: usize = 512 * 1024;
const MAX_RESOURCE_REDACTIONS: usize = 256;
const MAX_RESOURCE_REDACTION_BYTES: usize = 64 * 1024;
const MAX_ENGINE_LINE_BYTES: usize = 64 * 1024;
const MAX_ENGINE_STDERR_BYTES: usize = 512 * 1024;
const MAX_TERMINAL_ENTRIES: usize = 32;
const MAX_TERMINAL_BYTES: usize = 16 * 1024;
const MAX_TERMINAL_REASON_BYTES: usize = 2048;
const MAX_RETIRED_ENGINE_IDS: usize = 4096;
const MAX_RETIRED_PATH_REFS: usize = 4096;
const MAX_RETIRED_ENGINE_BINARIES: usize = 4096;
const MAX_PENDING_ENGINE_SEARCHES: usize = 256;
/// Join budget for the stderr drain after `io.terminate` returns. A stuck
/// drain is then aborted so `terminate` cannot stall on a logging task.
const STDERR_REAP_TIMEOUT: Duration = Duration::from_millis(200);

/// Folds a primary shutdown step and the step that follows it (stop then terminate, termination
/// then reap or join) into one result; a failed primary keeps the follow-up as its cleanup. The
/// actor, the supervisor and pending-actor registration all call it.
fn combine_shutdown_results(
    stop: Result<(), Error>,
    terminate: Result<(), Error>,
) -> Result<(), Error> {
    match (stop, terminate) {
        (Ok(()), Ok(())) => Ok(()),
        (Ok(()), Err(terminate)) => Err(terminate),
        (Err(stop), terminate) => Err(Error::with_cleanup(stop, terminate)),
    }
}

mod actor;
mod child;
mod logs;
mod registration;
mod supervisor;
#[cfg(test)]
mod test_doubles;
#[cfg(test)]
mod tests;

// Production siblings reach `actor` and `supervisor` items only through the re-exports below;
// the tests and the test doubles also use their private items.
#[cfg(test)]
use actor::*;
use child::*;
use logs::*;
use registration::*;
#[cfg(test)]
use supervisor::*;
#[cfg(test)]
use test_doubles::*;

pub(crate) use actor::verify_option_resources;
pub use actor::EngineActor;
pub use logs::EngineLog;
#[cfg(test)]
pub(crate) use registration::CLEANUP_FAILURE_LOG;
#[cfg(all(test, unix))]
pub(crate) use registration::REGISTRATION_GUARD_DROPS;
pub(crate) use registration::{
    log_registration_cleanup_error, resolve_launch, resolve_option_leases, spawn_registered,
    EngineBinaryRetirement, RegistrationGuard,
};
pub(crate) use supervisor::AdmissionLease;
pub use supervisor::{EngineSupervisor, SupervisedEngine};
