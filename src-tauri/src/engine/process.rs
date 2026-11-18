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

#[cfg(target_os = "windows")]
pub const CREATE_NO_WINDOW: u32 = 0x08000000;

#[cfg(windows)]
fn transfer_windows_resource_seals(
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

/// Engine transcript entries include explicit truncation metadata when bounded
/// retention has discarded older output.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(tag = "type", content = "value", rename_all = "camelCase")]
pub enum EngineLog {
    Gui(String),
    Engine(String),
    Truncated {
        #[serde(rename = "droppedEntries")]
        dropped_entries: u64,
    },
}

impl EngineLog {
    fn byte_len(&self) -> usize {
        match self {
            Self::Gui(line) | Self::Engine(line) => line.len(),
            Self::Truncated { .. } => 0,
        }
    }
}

#[derive(Debug, Default)]
struct BoundedLogs {
    entries: VecDeque<EngineLog>,
    bytes: usize,
    truncated: bool,
    dropped_entries: u64,
}

impl BoundedLogs {
    fn push(&mut self, entry: EngineLog) {
        // A pathological single UCI line must not turn the bounded log into an
        // unbounded allocation. It is retained with a visible suffix before
        // accounting, so it does not unnecessarily evict the whole transcript.
        let (entry, was_truncated) = normalize_log_entry(entry);
        self.truncated |= was_truncated;
        self.evict_for(entry.byte_len(), true);
        self.bytes += entry.byte_len();
        self.entries.push_back(entry);
    }

    fn entries(&self) -> Vec<EngineLog> {
        let mut entries =
            Vec::with_capacity(self.entries.len() + if self.truncated { 1 } else { 0 });
        if self.truncated {
            entries.push(EngineLog::Truncated {
                dropped_entries: self.dropped_entries,
            });
        }
        entries.extend(self.entries.iter().cloned());
        entries
    }

    fn redact(&mut self, values: &[String]) {
        if values.is_empty() {
            return;
        }

        let previous = std::mem::take(&mut self.entries);
        let mut entries = VecDeque::with_capacity(previous.len());
        for entry in previous {
            let entry = match entry {
                EngineLog::Gui(line) => EngineLog::Gui(redact_line(line, values)),
                EngineLog::Engine(line) => EngineLog::Engine(redact_line(line, values)),
                entry @ EngineLog::Truncated { .. } => entry,
            };
            let (entry, was_truncated) = normalize_log_entry(entry);
            self.truncated |= was_truncated;
            entries.push_back(entry);
        }
        self.entries = entries;
        self.bytes = self.entries.iter().map(EngineLog::byte_len).sum();
        self.evict_for(0, false);
    }

    fn evict_for(&mut self, incoming_bytes: usize, reserve_slot: bool) {
        let max_entries = MAX_LOG_LINES.saturating_sub(usize::from(reserve_slot));
        while !self.entries.is_empty()
            && (self.entries.len() > max_entries
                || self.bytes.saturating_add(incoming_bytes) > MAX_LOG_BYTES)
        {
            let Some(removed) = self.entries.pop_front() else {
                break;
            };
            self.bytes = self.bytes.saturating_sub(removed.byte_len());
            self.truncated = true;
            self.dropped_entries = self.dropped_entries.saturating_add(1);
        }
    }
}

fn normalize_log_entry(entry: EngineLog) -> (EngineLog, bool) {
    match entry {
        EngineLog::Gui(mut line) if line.len() > MAX_LOG_BYTES => {
            truncate_utf8(&mut line, MAX_LOG_BYTES.saturating_sub(16));
            line.push_str("… [truncated]");
            (EngineLog::Gui(line), true)
        }
        EngineLog::Engine(mut line) if line.len() > MAX_LOG_BYTES => {
            truncate_utf8(&mut line, MAX_LOG_BYTES.saturating_sub(16));
            line.push_str("… [truncated]");
            (EngineLog::Engine(line), true)
        }
        entry => (entry, false),
    }
}

fn redact_line(mut line: String, values: &[String]) -> String {
    for value in values {
        line = line.replace(value, "[redacted]");
    }
    line
}

#[derive(Debug, Default)]
struct ResourceRedactions {
    values: Vec<String>,
    bytes: usize,
}

impl ResourceRedactions {
    fn register(&mut self, values: &[String], logs: &mut BoundedLogs) -> Result<(), Error> {
        let mut additions = Vec::new();
        for value in values {
            if !value.is_empty()
                && !self.values.iter().any(|known| known == value)
                && !additions.iter().any(|known| known == value)
            {
                additions.push(value.clone());
            }
        }
        let added_bytes = additions.iter().map(String::len).sum::<usize>();
        if self.values.len().saturating_add(additions.len()) > MAX_RESOURCE_REDACTIONS
            || self.bytes.saturating_add(added_bytes) > MAX_RESOURCE_REDACTION_BYTES
        {
            return Err(Error::ResourceLimit(
                "engine resource redaction budget exhausted".into(),
            ));
        }
        if additions.is_empty() {
            return Ok(());
        }

        self.values.extend(additions);
        self.bytes = self.bytes.saturating_add(added_bytes);
        self.values
            .sort_by(|left, right| right.len().cmp(&left.len()).then_with(|| left.cmp(right)));
        logs.redact(&self.values);
        Ok(())
    }

    fn redact(&self, line: String) -> String {
        redact_line(line, &self.values)
    }
}

fn truncate_utf8(value: &mut String, max_bytes: usize) {
    if value.len() <= max_bytes {
        return;
    }
    let mut end = max_bytes;
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    value.truncate(end);
}

/// This tail is shared only by the actor and its stderr drain. All retained text
/// is safe already, and registering provenance also scrubs earlier echoes.
#[derive(Default)]
struct TerminalDiagnostics {
    entries: VecDeque<EngineTerminalEntry>,
    resource_values: Vec<String>,
    dropped: bool,
    last_info: Option<String>,
    last_stderr: Option<String>,
}

impl TerminalDiagnostics {
    fn register(&mut self, values: &[String]) {
        self.resource_values = values.to_vec();
        for entry in &mut self.entries {
            if let EngineTerminalEntry::InfoString(text) | EngineTerminalEntry::Stderr(text) = entry
            {
                *text = redact_line(std::mem::take(text), values);
            }
        }
        for text in [&mut self.last_info, &mut self.last_stderr]
            .into_iter()
            .flatten()
        {
            *text = redact_line(std::mem::take(text), values);
        }
        self.evict();
    }

    fn push(&mut self, text: &str, info: bool) {
        let mut text = sanitize_terminal_text(&redact_line(text.into(), &self.resource_values));
        if text.trim().is_empty() {
            return;
        }
        if text.len() > MAX_TERMINAL_REASON_BYTES {
            truncate_utf8(&mut text, MAX_TERMINAL_REASON_BYTES - "… [truncated]".len());
            text.push_str("… [truncated]");
            self.dropped = true;
        }
        if info {
            self.last_info = Some(text.clone());
            self.entries
                .push_back(EngineTerminalEntry::InfoString(text));
        } else {
            self.last_stderr = Some(text.clone());
            self.entries.push_back(EngineTerminalEntry::Stderr(text));
        }
        self.evict();
    }

    fn evict(&mut self) {
        // Serialized accounting includes the entry tags, escaped strings and
        // the visible truncation marker, as well as all UTF-8 text bytes.
        loop {
            let entries = self.entries();
            let bytes = serde_json::to_vec(&entries).map_or(usize::MAX, |bytes| bytes.len());
            if entries.len() <= MAX_TERMINAL_ENTRIES && bytes <= MAX_TERMINAL_BYTES {
                break;
            }
            if self.entries.pop_front().is_none() {
                break;
            }
            self.dropped = true;
        }
    }

    fn entries(&self) -> Vec<EngineTerminalEntry> {
        let mut entries = Vec::with_capacity(self.entries.len() + usize::from(self.dropped));
        if self.dropped {
            entries.push(EngineTerminalEntry::Truncated);
        }
        entries.extend(self.entries.iter().cloned());
        entries
    }

    fn snapshot(
        &self,
        kind: EngineFailureKind,
        exit_status: Option<EngineExitStatus>,
    ) -> EngineTerminalSnapshot {
        EngineTerminalSnapshot {
            kind,
            exit_status,
            reason: self.last_info.clone().or_else(|| self.last_stderr.clone()),
            entries: self.entries(),
        }
    }
}

#[derive(Clone, Copy)]
struct TerminalQuotedToken {
    quote: u8,
    start: usize,
    close: Option<usize>,
    end: usize,
}

// JSON wrapping changes delimiter escape depth. Only the exact opening depth
// can close a token. Other depths are ambiguous and remain literal content.
fn terminal_quoted_token(text: &str, at: usize) -> Option<TerminalQuotedToken> {
    let bytes = text.as_bytes();
    let delimiter = |at: usize| {
        let depth = bytes[at..]
            .iter()
            .take_while(|byte| **byte == b'\\')
            .count();
        let quote = *bytes.get(at + depth)?;
        matches!(quote, b'\'' | b'"').then_some((quote, depth, at + depth + 1))
    };
    let (quote, depth, start) = delimiter(at)?;
    let matches_close = |candidate: u8, escapes: usize, quote: u8, depth: usize| {
        candidate == quote && escapes == depth
    };
    let mut cursor = start;
    while cursor < bytes.len() {
        if let Some((candidate, escapes, end)) = delimiter(cursor) {
            if matches_close(candidate, escapes, quote, depth) {
                return Some(TerminalQuotedToken {
                    quote,
                    start,
                    close: Some(cursor),
                    end,
                });
            }
            cursor = end;
        } else {
            cursor += 1;
        }
    }
    Some(TerminalQuotedToken {
        quote,
        start,
        close: None,
        end: bytes.len(),
    })
}

/// Treat diagnostics as plain text. Credentials and native path spellings are
/// removed before truncation, while FEN boards and PGN draw notation survive.
fn sanitize_terminal_text(text: &str) -> String {
    let text: String = text
        .chars()
        .map(|ch| {
            if ch.is_control() || ch.is_whitespace() {
                ' '
            } else {
                ch
            }
        })
        .collect();
    let mut output = String::new();
    let mut index = 0;
    while index < text.len() {
        let rest = &text[index..];
        let boundary = index == 0 || !text.as_bytes()[index - 1].is_ascii_alphanumeric();
        let quoted = terminal_quoted_token(&text, index);
        let secret = if boundary {
            (|| {
                let (key_start, key_end, mut end) = match quoted {
                    Some(token) => (token.start, token.close?, token.end),
                    None => {
                        let length = rest
                            .bytes()
                            .take_while(|byte| {
                                byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-')
                            })
                            .count();
                        (index, index + length, index + length)
                    }
                };
                let key = text[key_start..key_end].to_ascii_lowercase();
                if !key
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
                {
                    return None;
                }
                let bearer = key == "bearer";
                if !bearer
                    && key != "authorization"
                    && ![
                        "token", "secret", "password", "passwd", "apikey", "api_key", "api-key",
                    ]
                    .iter()
                    .any(|suffix| key.ends_with(suffix))
                {
                    return None;
                }
                while text
                    .as_bytes()
                    .get(end)
                    .is_some_and(u8::is_ascii_whitespace)
                {
                    end += 1;
                }
                if bearer {
                    if end == key_end {
                        return None;
                    }
                } else {
                    if !matches!(text.as_bytes().get(end), Some(b'=' | b':')) {
                        return None;
                    }
                    end += 1;
                    while text
                        .as_bytes()
                        .get(end)
                        .is_some_and(u8::is_ascii_whitespace)
                    {
                        end += 1;
                    }
                }
                if let Some(value) = terminal_quoted_token(&text, end) {
                    return Some((value.start, value.close.unwrap_or(text.len()), value.end));
                }
                // Unquoted credentials have no reliable boundary. Redact the tail.
                Some((end, text.len(), text.len()))
            })()
        } else {
            None
        };
        if let Some((start, end, next)) = secret {
            output.push_str(&text[index..start]);
            output.push_str("[redacted]");
            output.push_str(&text[end..next]);
            index = next;
            continue;
        }
        if let Some(delimiter) = quoted.filter(|delimiter| delimiter.quote == b'"') {
            output.push_str(&text[index..delimiter.start]);
            index = delimiter.start;
            continue;
        }
        let path = boundary
            && (rest.starts_with('/')
                || rest.starts_with("\\\\")
                || rest.starts_with("~/")
                || rest.starts_with("~\\")
                || rest.starts_with("./")
                || rest.starts_with("../")
                || rest.starts_with(".\\")
                || rest.starts_with("..\\")
                || (rest.len() >= 3
                    && rest.as_bytes()[0].is_ascii_alphabetic()
                    && rest.as_bytes()[1] == b':'
                    && matches!(rest.as_bytes()[2], b'/' | b'\\')));
        if path {
            let quote = index
                .checked_sub(1)
                .and_then(|previous| text.as_bytes().get(previous))
                .copied()
                .filter(|byte| matches!(byte, b'\'' | b'"'));
            let end = rest
                .find(|ch: char| match quote {
                    Some(quote) => ch == quote as char,
                    None => ch.is_whitespace() || matches!(ch, '\'' | '"' | ',' | ';' | ')'),
                })
                .map_or(text.len(), |offset| index + offset);
            output.push_str("[path]");
            index = end;
            continue;
        }
        // Copy whole chess tokens so their internal slashes cannot look like
        // absolute paths at the next scanner step.
        if boundary && "rnbqkpRNBQKP12345678".contains(rest.as_bytes()[0] as char) {
            let token_end = rest.find(char::is_whitespace).unwrap_or(rest.len());
            let token = &rest[..token_end];
            if token == "1/2-1/2"
                || (token.contains('/')
                    && token.chars().all(|ch| "/rnbqkpRNBQKP12345678".contains(ch)))
            {
                output.push_str(token);
                index += token.len();
                continue;
            }
        }
        let Some(ch) = rest.chars().next() else {
            break;
        };
        output.push(ch);
        index += ch.len_utf8();
    }
    output
}

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

#[cfg(test)]
struct ReadObservation {
    started: Option<Arc<AtomicBool>>,
    attempts: Option<Arc<std::sync::atomic::AtomicUsize>>,
}

#[cfg(test)]
struct FakeIo {
    writes: Arc<Mutex<Vec<String>>>,
    write_completions: Arc<Mutex<Vec<(String, Instant)>>>,
    write_delays: Vec<(String, Duration)>,
    lines: VecDeque<(Duration, Option<String>)>,
    endless_line: Option<String>,
    read_interval: Duration,
    pending_when_empty: bool,
    terminate_calls: Arc<std::sync::atomic::AtomicUsize>,
    fail_write: bool,
    fail_stop: bool,
    read_delay: Option<Duration>,
    read_observation: Option<ReadObservation>,
    terminate_delay: Option<Duration>,
    terminate_started: Option<Arc<AtomicBool>>,
    cancel_after_write: Option<(String, Arc<AtomicBool>)>,
    exchange_observation: Option<(ExchangePoint, oneshot::Sender<()>)>,
    blocked_write: Option<String>,
    termination_error: Option<Arc<Error>>,
    termination_gate: Option<Arc<TerminationReplyGate>>,
}

#[cfg(test)]
#[derive(Clone)]
enum ExchangePoint {
    Write(String),
    ReadAfter(String),
}

#[cfg(test)]
impl FakeIo {
    fn new(
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

struct ResumableLineReader<R> {
    reader: R,
    pending_line: Vec<u8>,
    discarding_line: bool,
}

impl<R: AsyncBufRead + Unpin> ResumableLineReader<R> {
    fn new(reader: R) -> Self {
        Self {
            reader,
            pending_line: Vec::new(),
            discarding_line: false,
        }
    }

    async fn read_line(&mut self) -> Result<Option<String>, Error> {
        let result = read_bounded_engine_line(&mut self.reader, &mut self.pending_line).await;
        self.discarding_line = matches!(result, Err(Error::ResourceLimit(_)));
        result
    }

    fn is_discarding_line(&self) -> bool {
        self.discarding_line
    }

    async fn discard_line_remainder(&mut self) -> std::io::Result<()> {
        if self.discarding_line || !self.pending_line.is_empty() {
            self.discarding_line = true;
            self.pending_line.clear();
            discard_engine_line_remainder(&mut self.reader).await?;
            self.discarding_line = false;
        }
        Ok(())
    }
}

struct ChildUciIo {
    cleanup: Arc<ChildOwner>,
    line_reader: ResumableLineReader<BufReader<ChildStdout>>,
    observed_exit: Arc<OnceLock<EngineExitStatus>>,
}

const MAX_OWNED_CHILDREN: usize = 4096;

/// Cleanup authority survives protocol task exit. A lease moves the handle out
/// of the mutex and restores it on cancellation, without locking across IO.
#[derive(Default)]
struct ChildOwner {
    state: StdMutex<ChildOwnership>,
}

#[derive(Default)]
struct ChildOwnership {
    control: Option<Box<dyn ChildControl>>,
    // Keep the validated executable, cwd and resource descriptors until confirmed
    // reaping. Linux executes the sealed target through `/proc/self/fd/N`.
    executable: Option<EngineExecutable>,
    slot: Option<OwnedSemaphorePermit>,
    leased: bool,
}

struct ChildLease<'a> {
    owner: &'a ChildOwner,
    control: Option<Box<dyn ChildControl>>,
    reaped: bool,
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
    fn lease(&self) -> Result<ChildLease<'_>, Error> {
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

    fn unresolved(&self) -> bool {
        let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.leased || state.control.is_some()
    }

    async fn terminate(&self, quit: Duration, reap: Duration, graceful: bool) -> Result<(), Error> {
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

struct ProcessChildControl {
    stdin: Option<ChildStdin>,
    child: Child,
    observed_exit: Arc<OnceLock<EngineExitStatus>>,
    kill_started: bool,
    #[cfg(all(test, unix))]
    terminate_failure: Option<TerminateFailure>,
    #[cfg(all(test, unix))]
    force_kill_started: bool,
}

#[async_trait]
trait ChildCleanup: Send {
    fn start_kill(&mut self) -> Result<(), Error>;
    async fn wait(&mut self) -> Result<(), Error>;
    #[cfg(all(test, unix))]
    fn clear_failure(&mut self) {}
}

#[async_trait]
trait ChildControl: ChildCleanup {
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

fn observed_exit_status(status: std::process::ExitStatus) -> EngineExitStatus {
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

enum ForceKillAndReap {
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

enum ReapTimeoutPolicy {
    EngineTimeout,
    #[cfg(test)]
    OperationAndCleanup,
}

fn map_force_kill_and_reap(
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

async fn force_kill_and_reap<C: ChildCleanup + ?Sized>(
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

async fn terminate_child<C: ChildControl + ?Sized>(
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

async fn read_bounded_engine_line<R: AsyncBufRead + Unpin>(
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

async fn discard_engine_line_remainder<R: AsyncBufRead + Unpin>(
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

async fn drain_engine_stderr<R: AsyncBufRead + Unpin>(
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

struct AbortJoinHandleOnDrop {
    handle: Option<tokio::task::JoinHandle<()>>,
}

impl AbortJoinHandleOnDrop {
    fn new(handle: tokio::task::JoinHandle<()>) -> Self {
        Self {
            handle: Some(handle),
        }
    }

    fn disarm(&mut self) {
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

/// One-owner UCI actor. Its state/request generation is kept beside IO so a
/// read is never served for a request that is no longer current, and the
/// `search_output_unsynchronized` ready barrier discards what a finished
/// search emits after its `bestmove`. Together they keep an old `bestmove`
/// from being attributed to a replacement search.
struct EngineRuntime {
    io: Box<dyn UciIo>,
    cleanup: Option<Arc<ChildOwner>>,
    state: EngineState,
    next_request: u64,
    /// Set when a search starts and cleared only by a `readyok` read while
    /// idle. UCI output carries no request id, so a line a finished search
    /// still emits after its `bestmove` is attributable only by this ready
    /// barrier: the engine answers `isready` after it, never before.
    search_output_unsynchronized: bool,
    deadlines: EngineDeadlines,
    logs: BoundedLogs,
    resource_redactions: ResourceRedactions,
    /// Drain task for this runtime's child stderr. Taken and joined in
    /// `terminate`; aborted in `Drop` if the runtime is discarded first.
    stderr_drain_task: Option<tokio::task::JoinHandle<()>>,
    termination_outcome: Option<ActorTerminationOutcome>,
    diagnostics: Arc<Mutex<TerminalDiagnostics>>,
    terminal_snapshot: Arc<OnceLock<EngineTerminalSnapshot>>,
}

type ActorTerminationOutcome = Arc<OnceLock<Result<(), Arc<Error>>>>;
type ActorJoin = Shared<BoxFuture<'static, Result<(), Arc<Error>>>>;

/// Cloneable client handle for the single-owner engine task. Search-output reads
/// select against control messages, while command writes and terminal-line or
/// configuration reads select against the termination interrupt via `exchange_io`.
#[derive(Clone)]
pub struct EngineActor {
    cleanup: Option<Arc<ChildOwner>>,
    tx: mpsc::Sender<EngineCommand>,
    control_tx: mpsc::Sender<EngineCommand>,
    // Await protocol-task completion independently of confirmed child reaping.
    // ChildOwner retains cleanup authority, including through PendingActor after
    // this task exits with an unconfirmed reap.
    task: Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>,
    joined: Arc<StdMutex<Option<ActorJoin>>>,
    termination_outcome: ActorTerminationOutcome,
    terminal_snapshot: Arc<OnceLock<EngineTerminalSnapshot>>,
    interrupt: CancellationToken,
    registration_identity: Arc<OnceLock<(EngineKey, u64)>>,
    pub(crate) resources: Arc<[Arc<crate::infra::path_authority::EngineResourceLease>]>,
    resource_verify: Duration,
}

#[cfg(test)]
pub(crate) struct TerminationReplyGate {
    pub(crate) parked: AtomicBool,
    released: AtomicBool,
    release: tokio::sync::Notify,
}

#[cfg(test)]
impl TerminationReplyGate {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            parked: AtomicBool::new(false),
            released: AtomicBool::new(false),
            release: tokio::sync::Notify::new(),
        })
    }

    async fn park(&self) {
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
static TERMINATION_REPLY_GATES: crate::infra::test_hooks::KeyedTestValues<
    (EngineKey, u64),
    Arc<TerminationReplyGate>,
> = crate::infra::test_hooks::KeyedTestValues::new();

#[cfg(test)]
static TEARDOWN_SNAPSHOT_GATES: crate::infra::test_hooks::KeyedTestValues<
    (EngineKey, u64),
    Arc<TerminationReplyGate>,
> = crate::infra::test_hooks::KeyedTestValues::new();

enum EngineCommand {
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

#[derive(Clone)]
pub struct SupervisedEngine {
    pub generation: u64,
    pub engine_id: String,
    pub executable: PathRef,
    pub actor: Arc<EngineActor>,
    pub cancelled: Arc<std::sync::atomic::AtomicBool>,
    barrier: PublicationBarrier,
    pub(crate) interactive: Arc<Mutex<Option<crate::chess::WarmEngine>>>,
    search: Arc<StdMutex<Option<SupervisedSearch>>>,
}

/// One publication boundary per search, independent of the actor's lifetime.
#[derive(Clone)]
pub(crate) struct SupervisedSearch {
    pub generation: u64,
    pub cancelled: Arc<AtomicBool>,
    barrier: PublicationBarrier,
}

/// Shared mechanics, with separate instances for actor lifetime and search ownership.
#[derive(Clone)]
struct PublicationBarrier {
    cancelled: Arc<AtomicBool>,
    publish: Arc<StdMutex<()>>,
}

impl PublicationBarrier {
    fn new(cancelled: Arc<AtomicBool>) -> Self {
        Self {
            cancelled,
            publish: Arc::default(),
        }
    }

    pub fn mark_cancelled(&self) {
        let _publish = self
            .publish
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        self.cancelled.store(true, Ordering::SeqCst);
    }

    pub fn try_publish<E>(&self, emit: impl FnOnce() -> Result<(), E>) -> Result<bool, E> {
        let _publish = self
            .publish
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if self.cancelled.load(Ordering::SeqCst) {
            return Ok(false);
        }
        emit()?;
        Ok(true)
    }
}

impl SupervisedSearch {
    fn new(generation: u64, cancelled: Arc<AtomicBool>) -> Self {
        Self {
            generation,
            barrier: PublicationBarrier::new(cancelled.clone()),
            cancelled,
        }
    }

    pub fn mark_cancelled(&self) {
        self.barrier.mark_cancelled();
    }

    pub fn try_publish<E>(&self, emit: impl FnOnce() -> Result<(), E>) -> Result<bool, E> {
        self.barrier.try_publish(emit)
    }
}

impl SupervisedEngine {
    pub fn new(
        generation: u64,
        engine_id: String,
        executable: PathRef,
        actor: Arc<EngineActor>,
        cancelled: Arc<AtomicBool>,
    ) -> Self {
        Self {
            generation,
            engine_id,
            executable,
            actor,
            barrier: PublicationBarrier::new(cancelled.clone()),
            cancelled,
            interactive: Arc::default(),
            search: Arc::default(),
        }
    }

    pub fn mark_cancelled(&self) {
        self.barrier.mark_cancelled();
        if let Some(search) = self.current_search() {
            search.mark_cancelled();
        }
    }

    pub(crate) fn current_search(&self) -> Option<SupervisedSearch> {
        self.search
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    pub(crate) fn owner_generation(&self) -> u64 {
        self.current_search()
            .map_or(self.generation, |search| search.generation)
    }

    fn bind_search(&self, search: SupervisedSearch) {
        let mut current = self
            .search
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(previous) = current.replace(search) {
            previous.mark_cancelled();
        }
        if self.cancelled.load(Ordering::SeqCst) {
            if let Some(search) = current.as_ref() {
                search.mark_cancelled();
            }
        }
    }

    pub fn try_publish<E>(&self, emit: impl FnOnce() -> Result<(), E>) -> Result<bool, E> {
        if let Some(search) = self.current_search() {
            return search.try_publish(emit);
        }
        self.barrier.try_publish(emit)
    }
}

struct RetiredSet<T> {
    order: VecDeque<T>,
    entries: HashSet<T>,
    capacity: usize,
}

impl<T: Eq + Hash + Clone> RetiredSet<T> {
    fn new(capacity: usize) -> Self {
        Self {
            order: VecDeque::new(),
            entries: HashSet::new(),
            capacity,
        }
    }

    fn insert(&mut self, entry: T) {
        if !self.entries.insert(entry.clone()) {
            return;
        }
        self.order.push_back(entry);
        if self.order.len() > self.capacity {
            if let Some(oldest) = self.order.pop_front() {
                self.entries.remove(&oldest);
            }
        }
    }

    fn remove(&mut self, entry: &T) {
        if self.entries.remove(entry) {
            self.order.retain(|queued| queued != entry);
        }
    }
}

// EngineKey::new reserves this namespace for native EngineKey::game construction.
// Pair retirement preserves a game's original binary until its exact-key cleanup.
fn is_game_engine_key(key: &EngineKey) -> bool {
    key.tab.starts_with(GAME_ENGINE_KEY_PREFIX)
}

/// Owns the registry boundary for interactive, report, config-probe, and game
/// engines. Replacement removes exactly one opaque key, shuts down that actor,
/// then publishes the new generation. `retire_engine` reaps every actor owned
/// by an application engine id. `retire_executables` tombstones PathRefs and
/// terminates matching actors without retiring the application id.
pub struct EngineSupervisor {
    #[cfg(test)]
    spawn_attempts: std::sync::atomic::AtomicUsize,
    child_slots: Arc<Semaphore>,
    next_generation: AtomicU64,
    sealed: AtomicBool,
    actors: DashMap<EngineKey, SupervisedEngine>,
    pending_actors: Arc<DashMap<u64, Arc<PendingActor>>>,
    admissions: Arc<DashMap<EngineKey, EngineAdmission>>,
    admission_coordination: StdMutex<()>,
    registration: Mutex<()>,
    retired: StdMutex<RetiredSet<String>>,
    retired_executables: StdMutex<RetiredSet<PathRef>>,
    retired_binaries: StdMutex<RetiredSet<(String, PathRef)>>,
    // `lifecycle` provides the per-key transition locks. Lifecycle transitions
    // may capture an actor before awaiting the per-key lock and recheck under
    // that lock before mutating an actor they still own. Kill and
    // `handoff_published_locked` instead cancel and move actors into
    // `pending_actors` under registration, then admission coordination,
    // without taking the lifecycle lock.
    lifecycle: KeyedLocks<EngineKey>,
}

impl Default for EngineSupervisor {
    fn default() -> Self {
        Self {
            #[cfg(test)]
            spawn_attempts: std::sync::atomic::AtomicUsize::new(0),
            child_slots: Arc::new(Semaphore::new(MAX_OWNED_CHILDREN)),
            next_generation: AtomicU64::default(),
            sealed: AtomicBool::default(),
            actors: DashMap::default(),
            pending_actors: Arc::default(),
            admissions: Arc::default(),
            admission_coordination: StdMutex::default(),
            registration: Mutex::default(),
            retired: StdMutex::new(RetiredSet::new(MAX_RETIRED_ENGINE_IDS)),
            retired_executables: StdMutex::new(RetiredSet::new(MAX_RETIRED_PATH_REFS)),
            retired_binaries: StdMutex::new(RetiredSet::new(MAX_RETIRED_ENGINE_BINARIES)),
            lifecycle: KeyedLocks::default(),
        }
    }
}

#[derive(Clone, Copy)]
enum AdmissionCancellation {
    Cancelled,
    EngineRetired,
}

impl AdmissionCancellation {
    fn error(self) -> Error {
        match self {
            Self::Cancelled => Error::Cancellation,
            Self::EngineRetired => Error::EngineRetired,
        }
    }
}

#[derive(Clone)]
struct EngineAdmission {
    generation: u64,
    engine_id: String,
    executable: PathRef,
    cancelled: Arc<AtomicBool>,
    cancellation_reason: Arc<OnceLock<AdmissionCancellation>>,
    prepared: bool,
}

impl EngineAdmission {
    fn cancel(&self, reason: AdmissionCancellation) {
        // Publish the immutable reason before the cancellation flag. Late lease holders retain
        // this exact admission's reason even after its registry entry has been removed.
        self.cancellation_reason.get_or_init(|| reason);
        self.cancelled.store(true, Ordering::SeqCst);
    }

    fn cancel_error(&self) -> Option<Error> {
        self.cancelled.load(Ordering::SeqCst).then(|| {
            self.cancellation_reason
                .get()
                .copied()
                .unwrap_or(AdmissionCancellation::Cancelled)
                .error()
        })
    }
}

pub(crate) struct AdmissionLease {
    admissions: Arc<DashMap<EngineKey, EngineAdmission>>,
    key: EngineKey,
    admission: EngineAdmission,
    operation_cancellation: Option<CancellationToken>,
    disarmed: bool,
}

impl AdmissionLease {
    fn generation(&self) -> u64 {
        self.admission.generation
    }

    fn cancel_error(&self) -> Option<Error> {
        if self
            .operation_cancellation
            .as_ref()
            .is_some_and(CancellationToken::is_cancelled)
        {
            return Some(Error::Cancellation);
        }
        self.admission.cancel_error()
    }

    fn disarm(&mut self) {
        self.disarmed = true;
    }

    fn operation_cancellation(&self) -> Option<CancellationToken> {
        self.operation_cancellation.clone()
    }

    fn cancellation_probe(&self) -> (Arc<AtomicBool>, Option<CancellationToken>) {
        (
            self.admission.cancelled.clone(),
            self.operation_cancellation.clone(),
        )
    }
}

impl Drop for AdmissionLease {
    fn drop(&mut self) {
        if self.disarmed {
            return;
        }
        cancel_admission_exact(&self.admissions, &self.key, &self.admission);
    }
}

fn cancel_admission_exact(
    admissions: &DashMap<EngineKey, EngineAdmission>,
    key: &EngineKey,
    admission: &EngineAdmission,
) -> bool {
    // Flag the captured lease even if a newer admission has already replaced
    // its map entry. A late holder must still observe cancellation of its Arc.
    admission.cancel(AdmissionCancellation::Cancelled);
    admissions
        .remove_if(key, |_, current| current.generation == admission.generation)
        .is_some()
}

impl EngineSupervisor {
    fn allocate_generation(&self) -> Result<u64, Error> {
        self.next_generation
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |value| {
                value.checked_add(1)
            })
            .map(|previous| previous + 1)
            .map_err(|_| Error::ResourceLimit("engine generation exhausted".into()))
    }

    fn validate_admission_policy(
        &self,
        key: &EngineKey,
        engine_id: &str,
        executable: &PathRef,
    ) -> Result<(), Error> {
        if self.sealed.load(Ordering::SeqCst) {
            return Err(Error::Conflict("application is shutting down".into()));
        }
        if self.is_retired(engine_id) {
            return Err(Error::EngineRetired);
        }
        if self.is_retired_executable(executable) {
            return Err(Error::Conflict("engine executable is retired".into()));
        }
        if !is_game_engine_key(key) && self.is_retired_binary(engine_id, executable) {
            return Err(Error::Conflict("engine binary pair is retired".into()));
        }
        Ok(())
    }

    fn cancel_admission(&self, key: &EngineKey, admission: &EngineAdmission) -> bool {
        cancel_admission_exact(&self.admissions, key, admission)
    }

    fn cancel_admissions_matching(
        &self,
        reason: AdmissionCancellation,
        predicate: impl Fn(&EngineKey, &EngineAdmission) -> bool,
    ) {
        let targets: Vec<_> = self
            .admissions
            .iter()
            .filter(|entry| predicate(entry.key(), entry.value()))
            .map(|entry| (entry.key().clone(), entry.value().clone()))
            .collect();
        for (key, admission) in targets {
            admission.cancel(reason);
            self.cancel_admission(&key, &admission);
        }
    }

    async fn admit(
        &self,
        key: EngineKey,
        engine_id: String,
        executable: PathRef,
        prepared: bool,
    ) -> Result<AdmissionLease, Error> {
        validate_uci_text("engine", &engine_id)?;
        self.validate_admission_policy(&key, &engine_id, &executable)?;
        let generation = self.allocate_generation()?;
        let admission = EngineAdmission {
            generation,
            engine_id,
            executable,
            cancelled: Arc::new(AtomicBool::new(false)),
            cancellation_reason: Arc::default(),
            prepared,
        };
        let lease = AdmissionLease {
            admissions: self.admissions.clone(),
            key,
            admission,
            operation_cancellation: None,
            disarmed: false,
        };
        {
            let _coordination = self
                .admission_coordination
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            self.validate_admission_policy(
                &lease.key,
                &lease.admission.engine_id,
                &lease.admission.executable,
            )?;
            if prepared
                && self
                    .admissions
                    .iter()
                    .filter(|entry| entry.value().prepared && entry.key() != &lease.key)
                    .count()
                    >= MAX_PENDING_ENGINE_SEARCHES
            {
                return Err(Error::ResourceLimit(
                    "too many pending engine searches".into(),
                ));
            }
            if let Some(previous) = self
                .admissions
                .insert(lease.key.clone(), lease.admission.clone())
            {
                previous.cancel(AdmissionCancellation::Cancelled);
            }
        }
        let _registration = self.registration.lock().await;
        if let Some(error) = lease.cancel_error() {
            return Err(error);
        }
        self.validate_admission_policy(
            &lease.key,
            &lease.admission.engine_id,
            &lease.admission.executable,
        )?;
        Ok(lease)
    }

    /// Reserves the exact engine generation and binds its publication barrier to the owning
    /// native operation. Cancellation is checked by the admission lease before an actor can be
    /// published, without creating a second engine identity or cancellation registry.
    pub(crate) async fn admit_for_operation(
        &self,
        key: EngineKey,
        engine_id: String,
        executable: PathRef,
        cancellation: CancellationToken,
    ) -> Result<AdmissionLease, Error> {
        let mut admission = self.admit(key, engine_id, executable, false).await?;
        admission.operation_cancellation = Some(cancellation);
        if let Some(error) = admission.cancel_error() {
            return Err(error);
        }
        Ok(admission)
    }

    pub(crate) async fn admit_for_launch(
        &self,
        key: EngineKey,
        engine_id: String,
        executable: PathRef,
    ) -> Result<AdmissionLease, Error> {
        self.admit(key, engine_id, executable, false).await
    }

    pub async fn prepare_engine_search(
        &self,
        key: EngineKey,
        engine_id: String,
        executable: PathRef,
    ) -> Result<String, Error> {
        let mut lease = self.admit(key, engine_id, executable, true).await?;
        let generation = lease.generation();
        lease.disarm();
        Ok(generation.to_string())
    }

    pub(crate) async fn consume_engine_search(
        &self,
        key: EngineKey,
        engine_id: String,
        executable: PathRef,
        generation: &str,
    ) -> Result<AdmissionLease, Error> {
        let generation = generation.parse::<u64>().map_err(|_| {
            Error::Conflict("engine search reservation is invalid or expired".into())
        })?;
        let _registration = self.registration.lock().await;
        let admission = {
            let _coordination = self
                .admission_coordination
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let Some(admission) = self.admissions.get(&key).map(|entry| entry.clone()) else {
                return Err(Error::Conflict(
                    "engine search reservation is invalid or expired".into(),
                ));
            };
            if admission.generation != generation {
                return Err(Error::Conflict(
                    "engine search reservation is invalid or expired".into(),
                ));
            }
            if let Some(error) = admission.cancel_error() {
                return Err(error);
            }
            if admission.engine_id != engine_id
                || admission.executable != executable
                || !admission.prepared
            {
                return Err(Error::Conflict(
                    "engine search reservation does not match the request".into(),
                ));
            }
            self.admissions.insert(
                key.clone(),
                EngineAdmission {
                    prepared: false,
                    ..admission.clone()
                },
            );
            admission
        };
        Ok(AdmissionLease {
            admissions: self.admissions.clone(),
            key,
            admission: EngineAdmission {
                prepared: false,
                ..admission
            },
            operation_cancellation: None,
            disarmed: false,
        })
    }

    fn with_retired<T>(&self, operation: impl FnOnce(&mut RetiredSet<String>) -> T) -> T {
        match self.retired.lock() {
            Ok(mut retired) => operation(&mut retired),
            Err(poisoned) => operation(&mut poisoned.into_inner()),
        }
    }

    fn is_retired(&self, engine_id: &str) -> bool {
        self.with_retired(|retired| retired.entries.contains(engine_id))
    }

    fn with_retired_executables<T>(
        &self,
        operation: impl FnOnce(&mut RetiredSet<PathRef>) -> T,
    ) -> T {
        match self.retired_executables.lock() {
            Ok(mut retired) => operation(&mut retired),
            Err(poisoned) => operation(&mut poisoned.into_inner()),
        }
    }

    fn is_retired_executable(&self, executable: &PathRef) -> bool {
        self.with_retired_executables(|retired| retired.entries.contains(executable))
    }

    fn with_retired_binaries<T>(
        &self,
        operation: impl FnOnce(&mut RetiredSet<(String, PathRef)>) -> T,
    ) -> T {
        let mut retired = self
            .retired_binaries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        operation(&mut retired)
    }

    fn is_retired_binary(&self, engine_id: &str, executable: &PathRef) -> bool {
        self.with_retired_binaries(|retired| {
            retired
                .entries
                .contains(&(engine_id.into(), executable.clone()))
        })
    }

    fn lifecycle_lease(&self, key: &EngineKey) -> KeyedLockLease<'_, EngineKey> {
        self.lifecycle.lease(key.clone())
    }

    #[cfg(test)]
    pub async fn replace(
        &self,
        key: EngineKey,
        actor: EngineActor,
    ) -> Result<SupervisedEngine, Error> {
        let engine_id = key.engine.clone();
        let executable = PathRef {
            id: format!("test-{}", key.engine),
        };
        self.replace_handle(key, Arc::new(actor), engine_id, executable)
            .await
    }

    #[cfg(test)]
    pub async fn replace_handle(
        &self,
        key: EngineKey,
        actor: Arc<EngineActor>,
        engine_id: String,
        executable: PathRef,
    ) -> Result<SupervisedEngine, Error> {
        let admission = match self
            .admit(key.clone(), engine_id.clone(), executable.clone(), false)
            .await
        {
            Ok(admission) => admission,
            Err(primary) => {
                return Err(Error::with_cleanup(primary, actor.terminate().await));
            }
        };
        let pending = self.track_pending_actor(key.clone(), actor, &admission);
        let mut actor_guard = PendingActorGuard::new(pending.clone(), self.pending_actors.clone());
        let result = self.publish_admitted(key, pending, admission).await;
        actor_guard.disarm();
        result
    }

    async fn publish_admitted(
        &self,
        key: EngineKey,
        pending: Arc<PendingActor>,
        admission: AdmissionLease,
    ) -> Result<SupervisedEngine, Error> {
        let previous = {
            let _registration = self.registration.lock().await;
            let _coordination = self
                .admission_coordination
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let valid = admission.cancel_error().is_none()
                && self
                    .validate_admission_policy(
                        &key,
                        &admission.admission.engine_id,
                        &admission.admission.executable,
                    )
                    .is_ok();
            if valid {
                self.observe_previous_termination_locked(&key, admission.generation())
            } else {
                None
            }
        };
        let lifecycle = self.lifecycle_lease(&key);
        let _transition = lifecycle.lock().await;
        self.publish_admitted_locked(key, pending, admission, previous)
            .await
    }

    async fn publish_admitted_locked(
        &self,
        key: EngineKey,
        pending: Arc<PendingActor>,
        mut admission: AdmissionLease,
        previous: Option<Arc<PendingTermination>>,
    ) -> Result<SupervisedEngine, Error> {
        let actor = pending
            .actor
            .get()
            .cloned()
            .ok_or(Error::EngineDisconnected)?;
        let _ = actor
            .registration_identity
            .set((key.clone(), admission.generation()));
        debug_assert!(actor
            .registration_identity
            .get()
            .is_some_and(|(bound_key, generation)| {
                bound_key == &key && *generation == admission.generation()
            }));
        if let Some(error) = admission.cancel_error() {
            return Err(reject_actor(&pending, self.pending_actors.clone(), error).await);
        }
        if let Err(error) = self.validate_admission_policy(
            &key,
            &admission.admission.engine_id,
            &admission.admission.executable,
        ) {
            return Err(reject_actor(&pending, self.pending_actors.clone(), error).await);
        }
        let previous = if previous.is_some() {
            previous
        } else {
            let _registration = self.registration.lock().await;
            let _coordination = self
                .admission_coordination
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            self.observe_previous_termination_locked(&key, admission.generation())
        };
        if let Some(previous) = previous {
            if let Err(primary) = previous.wait().await {
                return Err(reject_actor(&pending, self.pending_actors.clone(), primary).await);
            }
        }
        let registration = self.registration.lock().await;
        if let Err(error) = self.validate_admission_policy(
            &key,
            &admission.admission.engine_id,
            &admission.admission.executable,
        ) {
            drop(registration);
            return Err(reject_actor(&pending, self.pending_actors.clone(), error).await);
        }
        let published = {
            let _coordination = self
                .admission_coordination
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let current = self.admissions.get(&key).map(|entry| entry.clone());
            if current.as_ref().is_none_or(|current| {
                current.generation != admission.generation()
                    || current.cancelled.load(Ordering::SeqCst)
            }) {
                None
            } else {
                let generation = admission.generation();
                let entry = SupervisedEngine::new(
                    generation,
                    admission.admission.engine_id.clone(),
                    admission.admission.executable.clone(),
                    actor.clone(),
                    Arc::new(AtomicBool::new(false)),
                );
                debug_assert!(actor.registration_identity.get().is_some_and(
                    |(bound_key, bound_generation)| {
                        bound_key == &key && *bound_generation == generation
                    }
                ));
                self.actors.insert(key, entry.clone());
                self.pending_actors.remove(&generation);
                self.admissions.remove_if(&admission.key, |_, current| {
                    current.generation == generation
                });
                Some(entry)
            }
        };
        drop(registration);
        let Some(entry) = published else {
            return Err(
                reject_actor(&pending, self.pending_actors.clone(), Error::Cancellation).await,
            );
        };
        admission.disarm();
        Ok(entry)
    }

    /// Serialize stop, options, position, ready and go with the existing lifecycle lease.
    /// The returned snapshot owns only this search's output; the mirror stays with the actor.
    pub(crate) async fn start_interactive_search(
        self: &Arc<Self>,
        key: EngineKey,
        engine: EngineHandle,
        authority: crate::infra::path_authority::SharedPathAuthority,
        mut admission: AdmissionLease,
        options: crate::chess::EngineOptions,
        mode: &GoMode,
    ) -> Result<
        (
            crate::chess::EngineProcess,
            SupervisedEngine,
            SupervisedSearch,
        ),
        Error,
    > {
        let mut guard =
            RegistrationGuard::for_search(self.clone(), key.clone(), admission.generation());
        let lifecycle = self.lifecycle_lease(&key);
        let _transition = lifecycle.lock().await;
        if let Some(error) = admission.cancel_error() {
            return Err(error);
        }
        self.validate_admission_policy(&key, &admission.admission.engine_id, &engine.id)?;
        let search = SupervisedSearch::new(
            admission.generation(),
            admission.admission.cancelled.clone(),
        );
        let mut reused = None;
        if let Some(current) = self.get_exact(&key) {
            if current.engine_id == admission.admission.engine_id
                && current.executable == engine.id
                && !current.cancelled.load(Ordering::SeqCst)
                && current.actor.terminal_snapshot().is_none()
            {
                let mirror = current.interactive.lock().await;
                if mirror.as_ref().is_some_and(|warm| warm.can_reuse(&options)) {
                    reused = Some(current.clone());
                }
            }
        }
        let current = if let Some(current) = reused {
            current.bind_search(search.clone());
            if search.cancelled.load(Ordering::SeqCst) {
                return Err(Error::Cancellation);
            }
            if let Err(primary) = current.actor.stop_current().await {
                let primary =
                    cancelled_search_error(primary, search.cancelled.load(Ordering::SeqCst));
                let cleanup = self.reap_published(&key, current.generation).await;
                return Err(Error::with_cleanup(primary, cleanup));
            }
            if search.cancelled.load(Ordering::SeqCst) {
                return Err(Error::Cancellation);
            }
            let _registration = self.registration.lock().await;
            let _coordination = self
                .admission_coordination
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if let Some(error) = admission.cancel_error() {
                return Err(error);
            }
            self.validate_admission_policy(&key, &admission.admission.engine_id, &engine.id)?;
            self.admissions
                .remove_if(&key, |_, pending| pending.generation == search.generation);
            admission.disarm();
            current
        } else {
            let (executable, resolved) = resolve_launch(
                authority,
                engine,
                PathOperation::EngineExecute,
                &options.extra_options,
                &admission,
            )
            .await?;
            let pending = self.spawn_pending(&key, executable, &admission).await?;
            let mut guard = PendingActorGuard::new(pending.clone(), self.pending_actors.clone());
            let published = self
                .publish_admitted_locked(key.clone(), pending, admission, None)
                .await;
            guard.disarm();
            let current = published?;
            current.bind_search(search.clone());
            let initialized =
                crate::chess::WarmEngine::new(current.actor.clone(), resolved, &search.cancelled)
                    .await;
            match initialized {
                Ok(warm) => *current.interactive.lock().await = Some(warm),
                Err(primary) => {
                    let primary =
                        cancelled_search_error(primary, search.cancelled.load(Ordering::SeqCst));
                    let cleanup = self.reap_published(&key, current.generation).await;
                    return Err(Error::with_cleanup(primary, cleanup));
                }
            }
            current
        };
        let result = async {
            if search.cancelled.load(Ordering::SeqCst) {
                return Err(Error::Cancellation);
            }
            let mut mirror = current.interactive.lock().await;
            let warm = mirror.as_mut().ok_or(Error::EngineNotInitialized)?;
            warm.start(options, mode, &search.cancelled).await
        }
        .await;
        match result {
            Ok(process) => {
                guard.disarm();
                let mut snapshot = current;
                snapshot.search = Arc::new(StdMutex::new(Some(search.clone())));
                Ok((process, snapshot, search))
            }
            Err(Error::Cancellation) => {
                guard.disarm();
                Err(Error::Cancellation)
            }
            Err(primary) => {
                let primary =
                    cancelled_search_error(primary, search.cancelled.load(Ordering::SeqCst));
                let cleanup = self.reap_published(&key, current.generation).await;
                Err(Error::with_cleanup(primary, cleanup))
            }
        }
    }

    pub async fn terminate_exact(&self, key: &EngineKey, generation: u64) -> Result<(), Error> {
        let target = {
            let _registration = self.registration.lock().await;
            let _coordination = self
                .admission_coordination
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let current = self
                .get_exact(key)
                .filter(|entry| entry.generation == generation);
            if let Some(current) = &current {
                current.mark_cancelled();
            }
            let targeted = current.map(|entry| entry.actor).or_else(|| {
                self.pending_actors
                    .get(&generation)
                    .filter(|entry| &entry.key == key)
                    .and_then(|entry| entry.actor.get().cloned())
            });
            if let Some(actor) = &targeted {
                actor.interrupt.cancel();
            }
            if let Some(admission) = self
                .admissions
                .get(key)
                .map(|entry| entry.clone())
                .filter(|entry| entry.generation == generation)
            {
                self.cancel_admission(key, &admission);
            }
            let attempt = self.observe_termination_locked(key, generation, false);
            ObservedTerminationTarget {
                key: key.clone(),
                generation,
                actor: targeted,
                attempt,
            }
        };
        self.wait_for_termination(&target).await
    }

    async fn wait_for_termination(&self, target: &ObservedTerminationTarget) -> Result<(), Error> {
        let lifecycle = self.lifecycle_lease(&target.key);
        let _transition = lifecycle.lock().await;
        match (&target.attempt, &target.actor) {
            (Some(attempt), _) => attempt.wait().await,
            (None, Some(actor)) => actor.final_termination_outcome().await,
            (None, None) => Ok(()),
        }
    }

    #[cfg(test)]
    pub async fn stop_exact(&self, key: &EngineKey) -> Result<(), Error> {
        self.stop_generation(key, None).await
    }

    #[cfg(test)]
    pub async fn stop_generation(
        &self,
        key: &EngineKey,
        generation: Option<u64>,
    ) -> Result<(), Error> {
        self.stop_or_release(key, generation, generation.is_none())
            .await
            .map(|_| ())
    }

    /// Whether this exact stop retained an actor serving the requested search.
    pub async fn stop_search(
        &self,
        key: &EngineKey,
        generation: Option<u64>,
    ) -> Result<bool, Error> {
        self.stop_or_release(key, generation, generation.is_none())
            .await
    }

    pub async fn release_generation(&self, key: &EngineKey, generation: u64) -> Result<(), Error> {
        self.stop_or_release(key, Some(generation), true)
            .await
            .map(|_| ())
    }

    async fn stop_or_release(
        &self,
        key: &EngineKey,
        generation: Option<u64>,
        release: bool,
    ) -> Result<bool, Error> {
        let (owner_generation, captured_admission, pending_owners) = {
            let _coordination = self
                .admission_coordination
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let owner_generation = self.actors.get(key).map(|entry| entry.owner_generation());
            let captured_admission = if generation.is_none() {
                self.admissions.get(key).map(|entry| entry.clone())
            } else {
                None
            };
            let pending_owners = if generation.is_none() {
                self.pending_actors
                    .iter()
                    .filter(|entry| &entry.key == key)
                    .map(|entry| entry.owner_generation)
                    .collect::<Vec<_>>()
            } else {
                Vec::new()
            };
            (owner_generation, captured_admission, pending_owners)
        };
        let mut target_generations = HashSet::new();
        if let Some(generation) = generation {
            target_generations.insert(generation);
        } else {
            target_generations.extend(owner_generation);
            target_generations.extend(pending_owners);
            target_generations.extend(captured_admission.as_ref().map(|entry| entry.generation));
        }
        if target_generations.is_empty() {
            return Ok(false);
        }
        let selected_actor = self
            .get_exact(key)
            .filter(|current| target_generations.contains(&current.owner_generation()))
            .map(|current| current.generation);
        if let Some(current) = self.get_exact(key) {
            if let Some(search) = current
                .current_search()
                .filter(|search| target_generations.contains(&search.generation))
            {
                search.mark_cancelled();
            }
        }
        let registration = self.registration.lock().await;
        let attempts = {
            let _coordination = self
                .admission_coordination
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let admission = match generation {
                Some(generation) => self
                    .admissions
                    .get(key)
                    .map(|entry| entry.clone())
                    .filter(|entry| entry.generation == generation),
                None => captured_admission,
            };
            if let Some(admission) = &admission {
                self.cancel_admission(key, admission);
            }
            if let Some(current) = self
                .get_exact(key)
                .filter(|entry| target_generations.contains(&entry.owner_generation()))
            {
                if release {
                    current.mark_cancelled();
                } else if let Some(search) = current.current_search() {
                    search.mark_cancelled();
                }
            }
            // Warm stop keeps serving the actor. Physical release, a terminal
            // actor, or an already handed-off owner binds cleanup before waiting.
            let physical = self.get_exact(key).filter(|current| {
                target_generations.contains(&current.owner_generation())
                    && (release || current.actor.terminal_snapshot().is_some())
            });
            let mut generations = self
                .pending_actors
                .iter()
                .filter_map(|entry| {
                    (&entry.key == key
                        && (target_generations.contains(&entry.owner_generation)
                            || selected_actor == Some(entry.generation)))
                    .then_some(entry.generation)
                })
                .collect::<HashSet<_>>();
            generations.extend(physical.map(|current| current.generation));
            generations
                .into_iter()
                .filter_map(|generation| self.observe_termination_locked(key, generation, true))
                .collect::<Vec<_>>()
        };
        drop(registration);
        let lifecycle = self.lifecycle_lease(key);
        let _transition = lifecycle.lock().await;
        if !attempts.is_empty() {
            let results =
                futures_util::future::join_all(attempts.iter().map(|attempt| attempt.wait())).await;
            return results
                .into_iter()
                .fold(Ok(()), combine_shutdown_results)
                .map(|_| false);
        }
        let Some(current) = self.actors.get(key).map(|entry| entry.clone()) else {
            if let Some(generation) = selected_actor {
                self.reap_published(key, generation).await?;
            }
            return Ok(false);
        };
        if !target_generations.contains(&current.owner_generation()) {
            // Equal actor generations mean the published actor now serves another search.
            // Leave that actor published so a stale exact stop cannot reap its new owner.
            if let Some(generation) =
                selected_actor.filter(|generation| *generation != current.generation)
            {
                self.reap_published(key, generation).await?;
            }
            return Ok(false);
        }
        if !release && current.actor.terminal_snapshot().is_none() {
            if let Some(search) = current.current_search() {
                search.mark_cancelled();
                let stop = current.actor.stop_current().await;
                return match stop {
                    Ok(()) => Ok(true),
                    Err(primary) => {
                        let cleanup = self.reap_published(key, current.generation).await;
                        Err(Error::with_cleanup(primary, cleanup))
                    }
                };
            }
        }
        current.mark_cancelled();
        let stop = current.actor.stop_current().await;
        let terminate = self.reap_published(key, current.generation).await;
        combine_shutdown_results(stop, terminate).map(|_| false)
    }

    /// Cancels work already admitted for this key without waiting for its launch lock.
    pub async fn kill_engine(&self, key: &EngineKey) -> Result<(), Error> {
        let (published, pending) = {
            let _registration = self.registration.lock().await;
            let _coordination = self
                .admission_coordination
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if let Some(mut admission) = self.admissions.get_mut(key) {
                admission.cancel(AdmissionCancellation::Cancelled);
                admission.prepared = false;
            }
            let published = self
                .get_exact(key)
                .and_then(|current| self.handoff_published_locked(key, current.generation));
            let pending: Vec<_> = self
                .pending_actors
                .iter()
                .filter(|entry| {
                    &entry.key == key
                        && published
                            .as_ref()
                            .is_none_or(|published| published.generation != entry.generation)
                })
                .map(|entry| entry.value().clone())
                .collect();
            let published = published.map(|entry| {
                let attempt = entry.start_termination(self.pending_actors.clone());
                (entry, attempt)
            });
            let pending = pending
                .into_iter()
                .map(|entry| {
                    let attempt = entry.start_termination(self.pending_actors.clone());
                    (entry, attempt)
                })
                .collect::<Vec<_>>();
            (published, pending)
        };
        #[cfg(test)]
        for (entry, _) in published.iter().chain(pending.iter()) {
            if let Some(gate) = TEARDOWN_SNAPSHOT_GATES.take(&(entry.key.clone(), entry.generation))
            {
                gate.park().await;
            }
        }
        let published = async {
            match published {
                Some((_, attempt)) => attempt.wait().await,
                None => Ok(()),
            }
        };
        let pending = futures_util::future::join_all(
            pending
                .into_iter()
                .map(|(_, attempt)| async move { attempt.wait().await }),
        );
        let (published, pending) = tokio::join!(published, pending);
        pending
            .into_iter()
            .fold(published, combine_shutdown_results)
    }

    // Caller holds registration, then admission coordination. Insert before removal so
    // every drain can see the child until the shared termination task completes.
    fn handoff_published_locked(
        &self,
        key: &EngineKey,
        generation: u64,
    ) -> Option<Arc<PendingActor>> {
        if let Some(current) = self
            .get_exact(key)
            .filter(|entry| entry.generation == generation)
        {
            current.mark_cancelled();
            let pending = self
                .pending_actors
                .entry(generation)
                .or_insert_with(|| {
                    let mut pending = PendingActor::new(
                        current.actor.clone(),
                        key.clone(),
                        generation,
                        current.engine_id.clone(),
                        current.executable.clone(),
                    );
                    pending.owner_generation = current.owner_generation();
                    Arc::new(pending)
                })
                .clone();
            self.actors
                .remove_if(key, |_, entry| entry.generation == generation);
            Some(pending)
        } else {
            self.pending_actors
                .get(&generation)
                .filter(|entry| &entry.key == key)
                .map(|entry| entry.value().clone())
        }
    }

    async fn reap_published(&self, key: &EngineKey, generation: u64) -> Result<(), Error> {
        let attempt = {
            let _registration = self.registration.lock().await;
            let _coordination = self
                .admission_coordination
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            self.observe_termination_locked(key, generation, false)
        };
        match attempt {
            Some(attempt) => attempt.wait().await,
            None => Ok(()),
        }
    }

    // Bind the immutable attempt under the publication barrier, before any
    // lifecycle wait. The attempt task owns cleanup even if its caller cancels.
    fn observe_termination_locked(
        &self,
        key: &EngineKey,
        generation: u64,
        stop_first: bool,
    ) -> Option<Arc<PendingTermination>> {
        self.handoff_published_locked(key, generation)
            .map(|entry| entry.start_termination_with_stop(self.pending_actors.clone(), stop_first))
    }

    fn observe_previous_termination_locked(
        &self,
        key: &EngineKey,
        generation: u64,
    ) -> Option<Arc<PendingTermination>> {
        let previous = self
            .get_exact(key)
            .map(|current| current.generation)
            .or_else(|| {
                self.pending_actors
                    .iter()
                    .filter(|entry| &entry.key == key && entry.generation < generation)
                    .filter(|entry| {
                        entry
                            .termination
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner())
                            .as_ref()
                            .is_some_and(|attempt| attempt.result.get().is_none())
                    })
                    .map(|entry| entry.generation)
                    .max()
            });
        previous.and_then(|previous| self.observe_termination_locked(key, previous, true))
    }

    pub fn get_exact(&self, key: &EngineKey) -> Option<SupervisedEngine> {
        self.actors.get(key).map(|entry| entry.clone())
    }

    #[cfg(test)]
    pub(crate) fn registered_keys_for_tab(&self, tab: &str) -> Vec<EngineKey> {
        self.actors
            .iter()
            .filter(|entry| entry.key().tab == tab)
            .map(|entry| entry.key().clone())
            .collect()
    }

    #[cfg(all(test, unix))]
    pub(crate) fn owned_keys_for_tab(&self, tab: &str) -> Vec<EngineKey> {
        let mut keys = self.registered_keys_for_tab(tab);
        for entry in self
            .pending_actors
            .iter()
            .filter(|entry| entry.key.tab == tab)
        {
            if !keys.contains(&entry.key) {
                keys.push(entry.key.clone());
            }
        }
        keys
    }

    #[cfg(test)]
    pub(crate) fn owns_generation(&self, key: &EngineKey, generation: u64) -> bool {
        self.get_exact(key)
            .is_some_and(|entry| entry.generation == generation)
            || self
                .pending_actors
                .get(&generation)
                .is_some_and(|entry| &entry.key == key)
    }

    pub fn cancel_exact(&self, key: &EngineKey, generation: u64) -> bool {
        let Some(current) = self.actors.get(key) else {
            return false;
        };
        if current.generation != generation {
            return false;
        }
        current.mark_cancelled();
        true
    }

    pub async fn terminate_tab(&self, tab: &str) -> Result<(), Error> {
        // Same publication barrier as `terminate_all` / `retire_engine`: wait
        // for in-flight admission and `publish_admitted` checks before scanning,
        // then drain until this tab has no actors.
        let registration = self.registration.lock().await;
        let _coordination = self
            .admission_coordination
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        self.cancel_admissions_matching(AdmissionCancellation::Cancelled, |key, _| key.tab == tab);
        drop(_coordination);
        drop(registration);
        self.drain_matching(|key, _, _| key.tab == tab).await
    }

    pub async fn retire_engine(&self, engine_id: String) -> Result<(), Error> {
        validate_uci_text("engine", &engine_id)?;
        self.with_retired(|retired| retired.insert(engine_id.clone()));
        self.retire_matching(AdmissionCancellation::EngineRetired, |key, owner, _| {
            key.engine == engine_id || owner == engine_id
        })
        .await
    }

    #[cfg(test)]
    pub async fn retire_engine_binary(
        &self,
        engine_id: String,
        retired: PathRef,
        current: PathRef,
    ) -> Result<(), Error> {
        let retirement = self
            .capture_binary_retirement(engine_id, retired, current, true)
            .await?;
        self.resume_binary_retirement(&retirement).await
    }

    /// Capture the original transition once. A workflow retains these exact generations so a
    /// later document can observe cleanup without changing the user's newer admission state.
    pub(crate) async fn capture_binary_retirement(
        &self,
        engine_id: String,
        retired: PathRef,
        current: PathRef,
        transition: bool,
    ) -> Result<EngineBinaryRetirement, Error> {
        validate_uci_text("engine", &engine_id)?;
        if retired == current || !transition {
            return Ok(EngineBinaryRetirement {
                targets: Vec::new(),
                observed: AtomicBool::new(false),
                observation: Mutex::new(()),
            });
        }
        let _registration = self.registration.lock().await;
        let _coordination = self
            .admission_coordination
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        self.with_retired_binaries(|binaries| {
            binaries.remove(&(engine_id.clone(), current));
            binaries.insert((engine_id.clone(), retired.clone()));
        });
        let matches = |key: &EngineKey, owner: &str, path: &PathRef| {
            !is_game_engine_key(key) && owner == engine_id && path == &retired
        };
        self.cancel_admissions_matching(AdmissionCancellation::Cancelled, |key, admission| {
            matches(key, &admission.engine_id, &admission.executable)
        });
        let published: Vec<_> = self
            .actors
            .iter()
            .filter(|entry| matches(entry.key(), &entry.engine_id, &entry.executable))
            .map(|entry| (entry.key().clone(), entry.generation))
            .collect();
        let mut targets: Vec<_> = self
            .pending_actors
            .iter()
            .filter(|entry| matches(&entry.key, &entry.engine_id, &entry.executable))
            .map(|entry| entry.value().clone())
            .collect();
        for (key, generation) in published {
            if let Some(entry) = self.handoff_published_locked(&key, generation) {
                if !targets.iter().any(|target| target.generation == generation) {
                    targets.push(entry);
                }
            }
        }
        // Bind cleanup before releasing the barrier, including spawning children.
        let targets = targets
            .into_iter()
            .map(|entry| {
                let attempt = entry.start_termination(self.pending_actors.clone());
                (entry, attempt)
            })
            .collect();
        Ok(EngineBinaryRetirement {
            targets,
            observed: AtomicBool::new(false),
            observation: Mutex::new(()),
        })
    }

    pub(crate) async fn resume_binary_retirement(
        &self,
        retirement: &EngineBinaryRetirement,
    ) -> Result<(), Error> {
        let _observation = retirement.observation.lock().await;
        let first = !retirement.observed.swap(true, Ordering::SeqCst);
        let failures =
            observe_pending_terminations(retirement.targets.iter().map(|(entry, original)| {
                let attempt = if first {
                    original.clone()
                } else {
                    entry.start_termination(self.pending_actors.clone())
                };
                (entry.clone(), attempt)
            }))
            .await;
        aggregate_shutdown_failures(failures)
    }

    pub async fn retire_executables(&self, executables: Vec<PathRef>) -> Result<(), Error> {
        if executables.is_empty() {
            return Ok(());
        }
        let executable_set: HashSet<_> = executables.iter().cloned().collect();
        self.with_retired_executables(|retired| {
            for executable in executables {
                retired.insert(executable);
            }
        });
        self.retire_matching(AdmissionCancellation::Cancelled, |_, _, executable| {
            executable_set.contains(executable)
        })
        .await
    }

    /// All tombstone operations cross the same admission/publication barrier before draining.
    async fn retire_matching(
        &self,
        reason: AdmissionCancellation,
        matches: impl Fn(&EngineKey, &str, &PathRef) -> bool,
    ) -> Result<(), Error> {
        let registration = self.registration.lock().await;
        {
            let _coordination = self
                .admission_coordination
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            self.cancel_admissions_matching(reason, |key, admission| {
                matches(key, &admission.engine_id, &admission.executable)
            });
        }
        drop(registration);
        self.drain_matching(matches).await
    }

    pub async fn terminate_all(&self) -> Result<(), Error> {
        self.sealed.store(true, Ordering::SeqCst);
        // Synchronize with admission and the final `publish_admitted` check.
        // Once this barrier is crossed, no production path can add an actor.
        let registration = self.registration.lock().await;
        let _coordination = self
            .admission_coordination
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        self.cancel_admissions_matching(AdmissionCancellation::Cancelled, |_, _| true);
        for entry in self.actors.iter() {
            entry.mark_cancelled();
        }
        drop(_coordination);
        drop(registration);
        self.drain_matching(|_, _, _| true).await
    }

    async fn drain_matching(
        &self,
        matches: impl Fn(&EngineKey, &str, &PathRef) -> bool,
    ) -> Result<(), Error> {
        let mut failures = Vec::new();
        let mut visited = HashSet::new();
        loop {
            // Publication moves between the two sets under this same barrier.
            let (targets, pending) = {
                let _registration = self.registration.lock().await;
                let _coordination = self
                    .admission_coordination
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                let targets: Vec<_> = self
                    .actors
                    .iter()
                    .filter(|entry| matches(entry.key(), &entry.engine_id, &entry.executable))
                    .filter(|entry| !visited.contains(&entry.generation))
                    .map(|entry| {
                        (
                            entry.key().clone(),
                            entry.value().generation,
                            entry.actor.clone(),
                        )
                    })
                    .collect();
                let pending: Vec<_> = self
                    .pending_actors
                    .iter()
                    .filter(|entry| matches(&entry.key, &entry.engine_id, &entry.executable))
                    .filter(|entry| !visited.contains(&entry.generation))
                    .map(|entry| entry.value().clone())
                    .collect();
                let targets = targets
                    .into_iter()
                    .map(|(key, generation, actor)| {
                        let attempt = self.observe_termination_locked(&key, generation, false);
                        ObservedTerminationTarget {
                            key,
                            generation,
                            actor: Some(actor),
                            attempt,
                        }
                    })
                    .collect::<Vec<_>>();
                let pending = pending
                    .into_iter()
                    .map(|entry| {
                        let attempt = entry.start_termination(self.pending_actors.clone());
                        (entry, attempt)
                    })
                    .collect::<Vec<_>>();
                (targets, pending)
            };
            if targets.is_empty() && pending.is_empty() {
                break;
            }
            visited.extend(targets.iter().map(|target| target.generation));
            visited.extend(pending.iter().map(|(entry, _)| entry.generation));
            #[cfg(test)]
            for target in &targets {
                if let Some(gate) =
                    TEARDOWN_SNAPSHOT_GATES.take(&(target.key.clone(), target.generation))
                {
                    gate.park().await;
                }
            }
            #[cfg(test)]
            for (entry, _) in &pending {
                if let Some(gate) =
                    TEARDOWN_SNAPSHOT_GATES.take(&(entry.key.clone(), entry.generation))
                {
                    gate.park().await;
                }
            }
            let pending = observe_pending_terminations(pending);
            let (registered, pending) = tokio::join!(self.terminate_targets(targets), pending);
            failures.extend(registered);
            failures.extend(pending);
        }
        aggregate_shutdown_failures(failures)
    }

    async fn terminate_targets(
        &self,
        targets: Vec<ObservedTerminationTarget>,
    ) -> Vec<ActorShutdownFailure> {
        let results =
            futures_util::future::join_all(targets.into_iter().map(|target| async move {
                let result = self.wait_for_termination(&target).await;
                (target.key, target.generation, result)
            }))
            .await;
        results
            .into_iter()
            .filter_map(|(key, generation, result)| {
                result.err().map(|error| ActorShutdownFailure {
                    key,
                    generation,
                    error,
                })
            })
            .collect()
    }

    #[cfg(test)]
    fn track_pending_actor(
        &self,
        key: EngineKey,
        actor: Arc<EngineActor>,
        admission: &AdmissionLease,
    ) -> Arc<PendingActor> {
        let _coordination = self
            .admission_coordination
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let generation = admission.generation();
        let _ = actor.registration_identity.set((key.clone(), generation));
        let pending = Arc::new(PendingActor::new(
            actor,
            key,
            generation,
            admission.admission.engine_id.clone(),
            admission.admission.executable.clone(),
        ));
        self.pending_actors.insert(generation, pending.clone());
        pending
    }

    async fn spawn_pending(
        &self,
        key: &EngineKey,
        executable: EngineExecutable,
        admission: &AdmissionLease,
    ) -> Result<Arc<PendingActor>, Error> {
        if let Some(error) = admission.cancel_error() {
            return Err(error);
        }
        let slot =
            self.child_slots.clone().try_acquire_owned().map_err(|_| {
                Error::ResourceLimit("engine child ownership capacity reached".into())
            })?;
        let cleanup = Arc::new(ChildOwner::default());
        cleanup.state.lock().unwrap_or_else(|e| e.into_inner()).slot = Some(slot);
        let pending = Arc::new(PendingActor {
            actor: OnceLock::new(),
            cleanup: Some(cleanup.clone()),
            spawning: AtomicBool::new(true),
            ready: Notify::new(),
            key: key.clone(),
            generation: admission.generation(),
            owner_generation: admission.generation(),
            engine_id: admission.admission.engine_id.clone(),
            executable: admission.admission.executable.clone(),
            termination: StdMutex::default(),
        });
        {
            let _coordination = self
                .admission_coordination
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            if let Some(error) = admission.cancel_error() {
                return Err(error);
            }
            self.pending_actors
                .insert(pending.generation, pending.clone());
        }
        let mut guard = PendingActorGuard::new(pending.clone(), self.pending_actors.clone());
        #[cfg(test)]
        self.spawn_attempts.fetch_add(1, Ordering::SeqCst);
        let spawned =
            EngineActor::spawn_owned(executable, EngineDeadlines::default(), cleanup).await;
        match spawned {
            Ok(actor) => {
                let actor = Arc::new(actor);
                let _ = actor
                    .registration_identity
                    .set((key.clone(), pending.generation));
                let _ = pending.actor.set(actor);
                pending.finish_spawn();
                guard.disarm();
                Ok(pending)
            }
            Err(primary) => {
                pending.finish_spawn();
                let result = reject_actor(&pending, self.pending_actors.clone(), primary).await;
                guard.disarm();
                Err(result)
            }
        }
    }
}

async fn reject_actor(
    pending: &Arc<PendingActor>,
    entries: Arc<DashMap<u64, Arc<PendingActor>>>,
    primary: Error,
) -> Error {
    Error::with_cleanup(primary, pending.terminate(entries).await)
}

struct ObservedTerminationTarget {
    key: EngineKey,
    generation: u64,
    actor: Option<Arc<EngineActor>>,
    attempt: Option<Arc<PendingTermination>>,
}

struct ActorShutdownFailure {
    key: EngineKey,
    generation: u64,
    error: Error,
}

async fn observe_pending_terminations(
    targets: impl IntoIterator<Item = (Arc<PendingActor>, Arc<PendingTermination>)>,
) -> Vec<ActorShutdownFailure> {
    let results =
        futures_util::future::join_all(targets.into_iter().map(|(entry, attempt)| async move {
            attempt
                .wait()
                .await
                .err()
                .map(|error| ActorShutdownFailure {
                    key: entry.key.clone(),
                    generation: entry.generation,
                    error,
                })
        }))
        .await;
    results.into_iter().flatten().collect()
}

pub(crate) struct RegistrationGuard {
    supervisor: Arc<EngineSupervisor>,
    key: EngineKey,
    generation: u64,
    taken: bool,
    search: bool,
}

struct PendingActor {
    actor: OnceLock<Arc<EngineActor>>,
    cleanup: Option<Arc<ChildOwner>>,
    spawning: AtomicBool,
    ready: Notify,
    key: EngineKey,
    generation: u64,
    owner_generation: u64,
    engine_id: String,
    executable: PathRef,
    termination: StdMutex<Option<Arc<PendingTermination>>>,
}

pub(crate) struct EngineBinaryRetirement {
    targets: Vec<(Arc<PendingActor>, Arc<PendingTermination>)>,
    observed: AtomicBool,
    observation: Mutex<()>,
}

#[derive(Default)]
struct PendingTermination {
    result: OnceLock<Result<(), Arc<Error>>>,
    completed: Notify,
}

impl PendingTermination {
    async fn wait(&self) -> Result<(), Error> {
        loop {
            let completed = self.completed.notified();
            tokio::pin!(completed);
            completed.as_mut().enable();
            if let Some(result) = self.result.get().cloned() {
                return result.map_err(Error::Shared);
            }
            completed.await;
        }
    }
}

impl PendingActor {
    fn new(
        actor: Arc<EngineActor>,
        key: EngineKey,
        generation: u64,
        engine_id: String,
        executable: PathRef,
    ) -> Self {
        Self {
            cleanup: actor.cleanup.clone(),
            actor: OnceLock::from(actor),
            spawning: AtomicBool::new(false),
            ready: Notify::new(),
            key,
            generation,
            owner_generation: generation,
            engine_id,
            executable,
            termination: StdMutex::default(),
        }
    }

    fn finish_spawn(&self) {
        self.spawning.store(false, Ordering::SeqCst);
        self.ready.notify_waiters();
    }

    async fn await_spawn(&self) {
        loop {
            let ready = self.ready.notified();
            tokio::pin!(ready);
            ready.as_mut().enable();
            if !self.spawning.load(Ordering::SeqCst) {
                return;
            }
            ready.await;
        }
    }

    fn start_termination(
        self: &Arc<Self>,
        entries: Arc<DashMap<u64, Arc<Self>>>,
    ) -> Arc<PendingTermination> {
        self.start_termination_with_stop(entries, false)
    }

    fn start_termination_with_stop(
        self: &Arc<Self>,
        entries: Arc<DashMap<u64, Arc<Self>>>,
        stop_first: bool,
    ) -> Arc<PendingTermination> {
        if !stop_first {
            if let Some(actor) = self.actor.get() {
                actor.interrupt.cancel();
            }
        }
        let mut termination = self
            .termination
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(attempt) = termination.as_ref() {
            if attempt.result.get().is_none()
                || !self
                    .cleanup
                    .as_ref()
                    .is_some_and(|owner| owner.unresolved())
            {
                return attempt.clone();
            }
        }
        let retry = termination.is_some();
        let attempt = Arc::new(PendingTermination::default());
        *termination = Some(attempt.clone());
        let entry = self.clone();
        let running = attempt.clone();
        tokio::spawn(async move {
            entry.await_spawn().await;
            let result = if retry || entry.actor.get().is_none() {
                let cleanup = match &entry.cleanup {
                    Some(owner) => {
                        owner
                            .terminate(Duration::ZERO, EngineDeadlines::default().kill_reap, false)
                            .await
                    }
                    None => Ok(()),
                };
                let joined = match entry.actor.get() {
                    Some(actor) => actor.reap_task().await,
                    None => Ok(()),
                };
                combine_shutdown_results(cleanup, joined)
            } else {
                match entry.actor.get() {
                    Some(actor) => {
                        let stop = if stop_first {
                            actor.stop_current().await
                        } else {
                            Ok(())
                        };
                        combine_shutdown_results(stop, actor.terminate().await)
                    }
                    None => Err(Error::EngineDisconnected),
                }
            }
            .map_err(Arc::new);
            if let Err(error) = &result {
                log_pending_actor_termination_error(&entry.key, entry.generation, error);
            }
            let _ = running.result.set(result);
            if !entry
                .cleanup
                .as_ref()
                .is_some_and(|owner| owner.unresolved())
            {
                entries.remove(&entry.generation);
            }
            running.completed.notify_waiters();
        });
        attempt
    }

    async fn terminate(
        self: &Arc<Self>,
        entries: Arc<DashMap<u64, Arc<Self>>>,
    ) -> Result<(), Error> {
        self.start_termination(entries).wait().await
    }
}

struct PendingActorGuard {
    entry: Option<Arc<PendingActor>>,
    entries: Arc<DashMap<u64, Arc<PendingActor>>>,
}

impl PendingActorGuard {
    fn new(entry: Arc<PendingActor>, entries: Arc<DashMap<u64, Arc<PendingActor>>>) -> Self {
        Self {
            entry: Some(entry),
            entries,
        }
    }

    fn disarm(&mut self) {
        self.entry = None;
    }
}

impl Drop for PendingActorGuard {
    fn drop(&mut self) {
        let Some(entry) = self.entry.take() else {
            return;
        };
        entry.finish_spawn();
        entry.start_termination(self.entries.clone());
    }
}

#[cfg(test)]
pub(crate) static CLEANUP_FAILURE_LOG: StdMutex<Vec<String>> = StdMutex::new(Vec::new());

#[cfg(test)]
pub(crate) static REGISTRATION_GUARD_DROPS: StdMutex<Vec<(EngineKey, u64, bool)>> =
    StdMutex::new(Vec::new());

#[cfg(test)]
static PENDING_ACTOR_CLEANUP_ERRORS: StdMutex<Vec<String>> = StdMutex::new(Vec::new());

#[cfg(test)]
static SHUTDOWN_FAILURE_LOGS: StdMutex<Vec<String>> = StdMutex::new(Vec::new());

fn log_pending_actor_termination_error(key: &EngineKey, generation: u64, error: &Error) {
    let message = format!(
        "engine actor termination failed for {}:{} generation={generation} category={} diagnostic={}",
        key.tab,
        key.engine,
        error.category(),
        error.diagnostic()
    );
    #[cfg(test)]
    match PENDING_ACTOR_CLEANUP_ERRORS.lock() {
        Ok(mut errors) => errors.push(message.clone()),
        Err(poisoned) => poisoned.into_inner().push(message.clone()),
    }
    error!("{message}");
}

pub(crate) fn log_registration_cleanup_error(
    key: Option<&EngineKey>,
    generation: Option<u64>,
    error: &Error,
) {
    let message = match (key, generation) {
        (Some(key), Some(generation)) => format!(
            "exact engine termination failed for {}:{} generation={generation} category={} error={}",
            key.tab,
            key.engine,
            error.category(),
            error.diagnostic()
        ),
        _ => format!(
            "exact engine termination failed for unregistered actor generation=unassigned category={} error={}",
            error.category(),
            error.diagnostic()
        ),
    };
    #[cfg(test)]
    match CLEANUP_FAILURE_LOG.lock() {
        Ok(mut errors) => errors.push(message.clone()),
        Err(poisoned) => poisoned.into_inner().push(message.clone()),
    }
    error!("{message}");
}

impl RegistrationGuard {
    pub(crate) fn new(supervisor: Arc<EngineSupervisor>, key: EngineKey, generation: u64) -> Self {
        Self {
            supervisor,
            key,
            generation,
            taken: false,
            search: false,
        }
    }

    pub(crate) fn for_search(
        supervisor: Arc<EngineSupervisor>,
        key: EngineKey,
        generation: u64,
    ) -> Self {
        Self {
            supervisor,
            key,
            generation,
            taken: false,
            search: true,
        }
    }

    pub(crate) fn disarm(&mut self) {
        self.taken = true;
    }

    pub(crate) async fn terminate_now(mut self) -> Result<(), Error> {
        let result =
            terminate_exact_and_log(&self.supervisor, &self.key, self.generation, self.search)
                .await;
        self.disarm();
        result
    }
}

async fn terminate_exact_and_log(
    supervisor: &EngineSupervisor,
    key: &EngineKey,
    generation: u64,
    search: bool,
) -> Result<(), Error> {
    let result = if search {
        supervisor.release_generation(key, generation).await
    } else {
        supervisor.terminate_exact(key, generation).await
    };
    if let Err(error) = &result {
        log_registration_cleanup_error(Some(key), Some(generation), error);
    }
    result
}

impl Drop for RegistrationGuard {
    fn drop(&mut self) {
        if self.taken {
            return;
        }
        let supervisor = self.supervisor.clone();
        let key = self.key.clone();
        let generation = self.generation;
        let search = self.search;
        #[cfg(test)]
        REGISTRATION_GUARD_DROPS
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push((key.clone(), generation, false));
        tokio::spawn(async move {
            // The helper logs a failure; a dropped guard has nobody to return it to.
            let _ = terminate_exact_and_log(&supervisor, &key, generation, search).await;
            #[cfg(test)]
            {
                let mut drops = REGISTRATION_GUARD_DROPS
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                if let Some((_, _, completed)) =
                    drops
                        .iter_mut()
                        .rev()
                        .find(|(dropped_key, dropped_generation, _)| {
                            dropped_key == &key && *dropped_generation == generation
                        })
                {
                    *completed = true;
                }
            }
        });
    }
}

#[derive(Debug)]
enum PinFailure {
    Primary(Error),
    #[cfg(target_os = "macos")]
    OperationAndCleanup {
        primary: Error,
        cleanup: Error,
    },
}

impl PinFailure {
    fn into_error(self, key: &EngineKey, engine_id: &str) -> Error {
        #[cfg(not(target_os = "macos"))]
        let _ = (key, engine_id);
        match self {
            Self::Primary(error) => error,
            #[cfg(target_os = "macos")]
            Self::OperationAndCleanup { primary, cleanup } => {
                log_pin_cleanup_failure(key, engine_id, &primary, &cleanup);
                Error::with_cleanup(primary, Err(cleanup))
            }
        }
    }
}

#[cfg(any(target_os = "macos", test))]
fn log_pin_cleanup_failure(key: &EngineKey, engine_id: &str, primary: &Error, cleanup: &Error) {
    error!(
        "engine launch pin failed for key={}:{} engine_id={} primary_category={} cleanup_category={} primary={} cleanup={}",
        key.tab, key.engine, engine_id, primary.category(), cleanup.category(), primary.diagnostic(), cleanup.diagnostic()
    );
}

#[cfg(target_os = "macos")]
fn cleanup_materialized_files(
    files: Vec<crate::infra::path_authority::MaterializedFile>,
) -> Option<Error> {
    let mut first = None;
    for file in files {
        if let Err(error) = file.remove() {
            if first.is_none() {
                first = Some(error);
            }
        }
    }
    first
}

#[cfg(target_os = "macos")]
fn pin_engine_launch(
    executable: &mut EngineExecutable,
    key: &EngineKey,
    engine_id: &str,
    is_cancelled: &dyn Fn() -> bool,
) -> Result<Vec<(String, String, Error)>, PinFailure> {
    let root = executable.launch_root().cloned().ok_or_else(|| {
        PinFailure::Primary(Error::Conflict(
            "engine launch root is not initialized".into(),
        ))
    })?;
    let reclaim = root.reclaim();
    let reclaim_failures = reclaim
        .failed
        .into_iter()
        .map(|(leaf, error)| (leaf.engine_key, leaf.engine_id, error))
        .collect::<Vec<_>>();
    let executable_leaf_count = 1;
    let count = executable
        .resource_leases()
        .iter()
        .filter(|lease| !lease.is_directory())
        .count()
        + executable_leaf_count;
    let mut files = match root.reserve_leaves(count, &engine_launch_key(key), engine_id) {
        Ok(files) => files,
        Err(error) => return Err(PinFailure::Primary(error)),
    };
    let result = (|| {
        files[0].create_from(
            executable.image_file(),
            crate::infra::path_authority::ENGINE_EXECUTABLE_LEAF_MODE,
            is_cancelled,
        )?;
        let mut file_index = 1;
        for lease in executable.resource_leases() {
            if lease.is_directory() {
                continue;
            }
            lease.file().metadata().map_err(Error::from)?;
            files[file_index].create_from(
                lease.file(),
                crate::infra::path_authority::ENGINE_RESOURCE_LEAF_MODE,
                is_cancelled,
            )?;
            lease.set_pinned_target(files[file_index].path())?;
            file_index += 1;
        }
        if is_cancelled() {
            return Err(Error::Cancellation);
        }
        let command_path = files[0].path();
        let retained = std::mem::take(&mut files);
        executable.set_launch_materialization(command_path, retained);
        Ok(())
    })();
    if let Err(primary) = result {
        if let Some(cleanup) = cleanup_materialized_files(files) {
            return Err(PinFailure::OperationAndCleanup { primary, cleanup });
        }
        return Err(PinFailure::Primary(primary));
    }
    Ok(reclaim_failures)
}

struct LaunchResult {
    executable: EngineExecutable,
    resolved: Vec<ResolvedEngineOption>,
    reclaim_failures: Vec<(String, String, Error)>,
}

pub(crate) async fn resolve_launch(
    authority: crate::infra::path_authority::SharedPathAuthority,
    engine: EngineHandle,
    operation: PathOperation,
    options: &[EngineOption],
    admission: &AdmissionLease,
) -> Result<(EngineExecutable, Vec<ResolvedEngineOption>), Error> {
    let (admission_cancelled, operation_cancellation) = admission.cancellation_probe();
    let engine_id = admission.admission.engine_id.clone();
    let key = admission.key.clone();
    let error_key = key.clone();
    let error_engine_id = engine_id.clone();
    let options = options.to_vec();
    #[cfg(all(test, unix))]
    let resolution_trace = crate::infra::path_authority::take_engine_resolution_trace_for_worker();
    let result = BLOCKING_GATEWAY
        .spawn(move || {
            #[cfg(all(test, unix))]
            let _resolution_trace_guard =
                crate::infra::path_authority::install_engine_resolution_trace_for_worker(
                    resolution_trace,
                );
            let is_cancelled = || {
                admission_cancelled.load(Ordering::SeqCst)
                    || operation_cancellation
                        .as_ref()
                        .is_some_and(CancellationToken::is_cancelled)
            };
            if is_cancelled() {
                return Ok(Err(PinFailure::Primary(Error::Cancellation)));
            }
            let (executable, mut resolved) = authority.with_mut(|authority| {
                let executable = authority.engine_executable(&engine, operation)?;
                let resolved = resolve_engine_option_leases(authority, &options)?;
                Ok::<_, Error>((executable, resolved))
            })??;
            if is_cancelled() {
                return Ok(Err(PinFailure::Primary(Error::Cancellation)));
            }
            #[cfg(all(test, unix))]
            ENGINE_LAUNCH_RESOLUTION_HOOKS.run(&key);
            let option_leases = resolved
                .iter()
                .flat_map(|option| option.resources.iter().cloned())
                .collect();
            let executable = executable.with_resource_leases(option_leases);
            #[cfg(target_os = "macos")]
            let (executable, reclaim_failures) = {
                let mut executable = executable;
                let reclaim_failures =
                    match pin_engine_launch(&mut executable, &key, &engine_id, &is_cancelled) {
                        Ok(reclaim_failures) => reclaim_failures,
                        Err(failure) => return Ok(Err(failure)),
                    };
                (executable, reclaim_failures)
            };
            #[cfg(all(test, target_os = "macos"))]
            if ENGINE_LAUNCH_VALUE_FAILURES.take(&key).is_some() {
                return Ok(Err(PinFailure::Primary(Error::Conflict(
                    "injected engine launch value construction failure".into(),
                ))));
            }
            #[cfg(all(test, target_os = "macos"))]
            ENGINE_LAUNCH_POST_PIN_HOOKS.run(&key);
            #[cfg(not(target_os = "macos"))]
            let reclaim_failures = Vec::new();
            for option in &mut resolved {
                option.refresh_resource_values()?;
            }
            Ok(Ok(LaunchResult {
                executable,
                resolved,
                reclaim_failures,
            }))
        })
        .await?;
    let result = result.map_err(|failure| {
        let error = failure.into_error(&error_key, &error_engine_id);
        // Only a bare cancellation can take the admission's semantic reason. A launch
        // materialization or cleanup failure must keep its own truthful category.
        match error {
            Error::Cancellation => admission.cancel_error().unwrap_or(error),
            error => error,
        }
    })?;
    for (reclaim_key, reclaim_id, error) in result.reclaim_failures {
        error!(
            "engine launch leaf reclaim failed for key={} engine_id={} category={}",
            reclaim_key,
            reclaim_id,
            error.category()
        );
    }
    if let Some(error) = admission.cancel_error() {
        return Err(error);
    }
    Ok((result.executable, result.resolved))
}

pub(crate) async fn resolve_option_leases(
    authority: crate::infra::path_authority::SharedPathAuthority,
    options: &[EngineOption],
    cancellation: CancellationToken,
) -> Result<Vec<ResolvedEngineOption>, Error> {
    let options = options.to_vec();
    BLOCKING_GATEWAY
        .spawn(move || {
            if cancellation.is_cancelled() {
                return Err(Error::Cancellation);
            }
            authority.with_mut(|authority| resolve_engine_option_leases(authority, &options))?
        })
        .await
}

/// Spawns and publishes an actor before any protocol initialization begins.
/// The caller owns the returned armed guard until ownership is transferred or
/// termination completes. Dropping it terminates exactly the published generation.
pub(crate) async fn spawn_registered<T, F, Fut>(
    supervisor: Arc<EngineSupervisor>,
    key: EngineKey,
    executable: EngineExecutable,
    admission: AdmissionLease,
    initialize: F,
) -> Result<(SupervisedEngine, RegistrationGuard, T), Error>
where
    F: FnOnce(Arc<EngineActor>) -> Fut,
    Fut: std::future::Future<Output = Result<T, Error>>,
{
    if let Some(error) = admission.cancel_error() {
        return Err(error);
    }
    let pending = supervisor
        .spawn_pending(&key, executable, &admission)
        .await?;
    initialize_pending_actor(supervisor, key, pending, admission, initialize).await
}

#[cfg(test)]
async fn initialize_registered_actor<T, F, Fut>(
    supervisor: Arc<EngineSupervisor>,
    key: EngineKey,
    actor: Arc<EngineActor>,
    engine_id: String,
    executable_ref: PathRef,
    initialize: F,
) -> Result<(SupervisedEngine, RegistrationGuard, T), Error>
where
    F: FnOnce(Arc<EngineActor>) -> Fut,
    Fut: std::future::Future<Output = Result<T, Error>>,
{
    let admission = supervisor
        .admit(key.clone(), engine_id, executable_ref, false)
        .await?;
    initialize_admitted_actor(supervisor, key, actor, admission, initialize).await
}

#[cfg(test)]
async fn initialize_admitted_actor<T, F, Fut>(
    supervisor: Arc<EngineSupervisor>,
    key: EngineKey,
    actor: Arc<EngineActor>,
    admission: AdmissionLease,
    initialize: F,
) -> Result<(SupervisedEngine, RegistrationGuard, T), Error>
where
    F: FnOnce(Arc<EngineActor>) -> Fut,
    Fut: std::future::Future<Output = Result<T, Error>>,
{
    let pending = supervisor.track_pending_actor(key.clone(), actor.clone(), &admission);
    initialize_pending_actor(supervisor, key, pending, admission, initialize).await
}

async fn initialize_pending_actor<T, F, Fut>(
    supervisor: Arc<EngineSupervisor>,
    key: EngineKey,
    pending: Arc<PendingActor>,
    admission: AdmissionLease,
    initialize: F,
) -> Result<(SupervisedEngine, RegistrationGuard, T), Error>
where
    F: FnOnce(Arc<EngineActor>) -> Fut,
    Fut: std::future::Future<Output = Result<T, Error>>,
{
    let operation_cancellation = admission.operation_cancellation();
    let actor = pending
        .actor
        .get()
        .cloned()
        .ok_or(Error::EngineDisconnected)?;
    let mut actor_guard =
        PendingActorGuard::new(pending.clone(), supervisor.pending_actors.clone());
    let published = supervisor
        .publish_admitted(key.clone(), pending, admission)
        .await;
    actor_guard.disarm();
    let supervised = match published {
        Ok(supervised) => supervised,
        Err(primary) => return Err(primary),
    };
    let guard = RegistrationGuard::new(supervisor.clone(), key.clone(), supervised.generation);
    let initialized = initialize(actor);
    tokio::pin!(initialized);
    let initialized = match operation_cancellation {
        Some(cancellation) => tokio::select! {
            biased;
            _ = cancellation.cancelled() => Err(Error::Cancellation),
            value = &mut initialized => value,
        },
        None => initialized.await,
    };
    match initialized {
        Ok(value) => Ok((supervised, guard, value)),
        Err(primary) => {
            let cleanup = guard.terminate_now().await;
            Err(Error::with_cleanup(primary, cleanup))
        }
    }
}

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

fn aggregate_shutdown_failures(failures: Vec<ActorShutdownFailure>) -> Result<(), Error> {
    let mut representative = None;
    for failure in failures {
        let message = format!(
            "engine cleanup failed for {}:{} generation={} category={}",
            failure.key.tab,
            failure.key.engine,
            failure.generation,
            failure.error.category()
        );
        #[cfg(test)]
        match SHUTDOWN_FAILURE_LOGS.lock() {
            Ok(mut errors) => errors.push(message.clone()),
            Err(poisoned) => poisoned.into_inner().push(message.clone()),
        }
        error!("{message}");
        if representative.is_none() {
            representative = Some(failure.error);
        }
    }
    representative.map_or(Ok(()), Err)
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

    async fn spawn_owned(
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

    async fn init_uci_cancellable(
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

    async fn next_configuration_line_cancellable(
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

    async fn set_option_with_resources(
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

    async fn reap_stderr_drain(&mut self) {
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

    async fn send(
        &mut self,
        command: &str,
        interrupt: Option<&CancellationToken>,
    ) -> Result<(), Error> {
        self.send_with_deadline(command, Instant::now() + self.deadlines.readyok, interrupt)
            .await
    }

    async fn send_with_deadline(
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

    async fn read_line(&mut self) -> Result<Option<String>, Error> {
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

    async fn record_output_line(&mut self, line: &str) {
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

    async fn drain_terminal_stdout(&mut self, registration_identity: &OnceLock<(EngineKey, u64)>) {
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

    async fn wait_for(
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

    async fn read_until<F>(
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
async fn exchange_io<T>(
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

#[cfg(test)]
struct GameCleanupTestIo {
    started: Arc<AtomicBool>,
    delay: Option<Duration>,
    error: Option<String>,
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
    fn clear_cleanup_test_failure(&self) {
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
    fn recording_test_actor_with_resources_and_deadlines_impl(
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
    fn from_runtime(runtime: EngineRuntime) -> Self {
        Self::from_runtime_with_resources(runtime, Arc::from([]))
    }

    fn from_runtime_with_resources(
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

    async fn spawn_owned(
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

    async fn request<T>(
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

    async fn request_control<T>(
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
    fn try_enqueue_set_option(
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

    fn recorded_termination_outcome(&self) -> Result<(), Error> {
        self.termination_outcome
            .get()
            .cloned()
            .ok_or(Error::EngineDisconnected)?
            .map_err(Error::Shared)
    }

    async fn final_termination_outcome(&self) -> Result<(), Error> {
        let joined = self.reap_task().await;
        combine_shutdown_results(self.recorded_termination_outcome(), joined)
    }

    async fn reap_task(&self) -> Result<(), Error> {
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

    fn disconnected_error(&self) -> Error {
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
    static SPAWN_ACTOR_OVERRIDE: std::cell::RefCell<Option<EngineActor>> =
        const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
struct SpawnActorOverrideGuard {
    // The override must be consumed and cleared on the thread where it was set.
    _same_thread: std::marker::PhantomData<std::rc::Rc<()>>,
}

#[cfg(test)]
impl SpawnActorOverrideGuard {
    fn new(actor: EngineActor) -> Self {
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
type ResourceVerifyHook = crate::infra::test_hooks::TestHook;

/// Keyed by the resource value under verification; see `infra::test_hooks`.
#[cfg(all(test, unix))]
static RESOURCE_VERIFY_HOOKS: crate::infra::test_hooks::KeyedTestHooks<String> =
    crate::infra::test_hooks::KeyedTestHooks::new();

#[cfg(all(test, unix))]
fn set_resource_verify_hook(key: String, hook: Option<ResourceVerifyHook>) {
    match hook {
        Some(hook) => RESOURCE_VERIFY_HOOKS.arm(key, hook),
        None => RESOURCE_VERIFY_HOOKS.clear(&key),
    }
}

#[cfg(all(test, unix))]
std::thread_local! {
    static SET_OPTION_BEFORE_SEND_HOOK: std::cell::RefCell<Option<ResourceVerifyHook>> =
        const { std::cell::RefCell::new(None) };
}

#[cfg(all(test, unix))]
fn set_option_before_send_hook(hook: Option<Box<dyn FnOnce() + Send>>) {
    SET_OPTION_BEFORE_SEND_HOOK.with(|slot| *slot.borrow_mut() = hook);
}

/// Both launch hooks are keyed by the engine identity `resolve_launch` was called for:
/// every concurrent launch reaches these fire sites, so an unkeyed slot made whichever
/// launch arrived first run a foreign test's hook (`f-20260917-09`, `infra::test_hooks`).
#[cfg(all(test, unix))]
static ENGINE_LAUNCH_RESOLUTION_HOOKS: crate::infra::test_hooks::KeyedTestHooks<EngineKey> =
    crate::infra::test_hooks::KeyedTestHooks::new();

#[cfg(all(test, target_os = "macos"))]
static ENGINE_LAUNCH_POST_PIN_HOOKS: crate::infra::test_hooks::KeyedTestHooks<EngineKey> =
    crate::infra::test_hooks::KeyedTestHooks::new();

#[cfg(test)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SpawnIoFailure {
    #[cfg(unix)]
    NoStdin,
    #[cfg(unix)]
    NoStdout,
    #[cfg(windows)]
    ResourceTransferAfter(usize),
}

#[cfg(test)]
std::thread_local! {
    static SPAWN_IO_FAILURE: std::cell::RefCell<Option<SpawnIoFailure>> =
        const { std::cell::RefCell::new(None) };
}

#[cfg(all(test, windows))]
std::thread_local! {
    static SPAWN_RESOURCE_TRANSFER_OBSERVED: std::cell::Cell<Option<(usize, usize)>> =
        const { std::cell::Cell::new(None) };
}

#[cfg(all(test, unix))]
type SpawnChildObserver = Box<dyn FnOnce(Option<u32>) + Send>;

#[cfg(all(test, unix))]
type SpawnChildObserverRegistration = (Arc<()>, SpawnChildObserver);

#[cfg(all(test, unix))]
struct SpawnChildObserverGuard {
    command_target: std::path::PathBuf,
    registration_id: Arc<()>,
}

#[cfg(all(test, unix))]
static SPAWN_CHILD_OBSERVERS: std::sync::OnceLock<
    std::sync::Mutex<HashMap<std::path::PathBuf, SpawnChildObserverRegistration>>,
> = std::sync::OnceLock::new();

#[cfg(test)]
fn set_spawn_io_failure(failure: Option<SpawnIoFailure>) {
    SPAWN_IO_FAILURE.with(|slot| *slot.borrow_mut() = failure);
}

#[cfg(test)]
fn take_spawn_io_failure() -> Option<SpawnIoFailure> {
    SPAWN_IO_FAILURE.with(|slot| slot.borrow_mut().take())
}

#[cfg(all(test, unix))]
fn set_spawn_child_observer(
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
fn take_spawn_child_observer(command_target: &std::path::Path) -> Option<SpawnChildObserver> {
    SPAWN_CHILD_OBSERVERS
        .get_or_init(|| std::sync::Mutex::new(HashMap::new()))
        .lock()
        .unwrap()
        .remove(command_target)
        .map(|(_, observer)| observer)
}

#[cfg(all(test, unix))]
fn observe_spawned_child(child: &Child, command_target: &std::path::Path) {
    if let Some(observer) = take_spawn_child_observer(command_target) {
        observer(child.id());
    }
}

#[cfg(all(test, unix))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TerminateFailure {
    QuitKillReap,
    ReapTimeout,
    ReapError,
}

#[cfg(all(test, unix))]
std::thread_local! {
    static TERMINATE_FAILURE: std::cell::RefCell<Option<TerminateFailure>> =
        const { std::cell::RefCell::new(None) };
}

#[cfg(all(test, unix))]
fn set_terminate_failure(failure: Option<TerminateFailure>) {
    TERMINATE_FAILURE.with(|slot| *slot.borrow_mut() = failure);
}

#[cfg(all(test, unix))]
fn take_terminate_failure() -> Option<TerminateFailure> {
    TERMINATE_FAILURE.with(|slot| slot.borrow_mut().take())
}

/// The engine key as the launch root records it on a reserved leaf. Tests that inject a
/// launch failure arm it under this same spelling.
#[cfg(target_os = "macos")]
pub(crate) fn engine_launch_key(key: &EngineKey) -> String {
    format!("{}:{}", key.tab, key.engine)
}

/// Keyed by the engine identity the launch was admitted for; see `infra::test_hooks`.
#[cfg(all(test, target_os = "macos"))]
static ENGINE_LAUNCH_VALUE_FAILURES: crate::infra::test_hooks::KeyedTestValues<EngineKey, ()> =
    crate::infra::test_hooks::KeyedTestValues::new();

async fn complete_exchange<T>(
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

fn exchange_failed_protocol(error: &Error) -> bool {
    error.is_engine_failure() || matches!(error, Error::EngineTimeout(_))
}

async fn engine_actor_loop(
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

async fn terminate_and_log(
    runtime: &mut EngineRuntime,
    registration_identity: &OnceLock<(EngineKey, u64)>,
) -> Result<(), Error> {
    let result = runtime.terminate().await;
    if let Err(error) = &result {
        log_actor_cleanup_failure(registration_identity, error);
    }
    result
}

async fn terminate_and_reply(
    runtime: &mut EngineRuntime,
    registration_identity: &OnceLock<(EngineKey, u64)>,
    reply: oneshot::Sender<Result<(), Error>>,
) {
    let result = terminate_and_log(runtime, registration_identity).await;
    let _ = reply.send(result);
}

fn log_actor_cleanup_failure(registration_identity: &OnceLock<(EngineKey, u64)>, error: &Error) {
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
async fn recover_failed_protocol<T>(
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

fn protocol_failure(cause: Error) -> Error {
    Error::EngineFailure {
        snapshot: None,
        cause: Box::new(cause),
        cleanup: None,
    }
}

fn disconnected_failure() -> Error {
    protocol_failure(Error::EngineDisconnected)
}

async fn stop_at_protocol_boundary(
    runtime: &mut EngineRuntime,
    registration_identity: &OnceLock<(EngineKey, u64)>,
    interrupt: &CancellationToken,
) -> Result<(), Error> {
    let result = runtime.stop_current(Some(interrupt)).await;
    recover_failed_protocol(runtime, registration_identity, result).await
}

async fn service_search_read(
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

fn reply_to_stopped_search(
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

fn reject_command_during_search(command: EngineCommand) {
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        collections::VecDeque,
        io,
        sync::{
            atomic::{AtomicBool, AtomicUsize, Ordering as AtomicOrdering},
            Arc,
        },
    };
    use tokio::{
        io::{AsyncBufRead, AsyncBufReadExt, AsyncRead, ReadBuf},
        sync::Mutex,
    };

    async fn terminal_diagnostics_from_lines(
        lines: &[String],
        stdout: bool,
    ) -> Arc<Mutex<TerminalDiagnostics>> {
        if stdout {
            let io = FakeIo::new(
                Arc::default(),
                lines.iter().map(|line| Some(format!("info string {line}"))),
            );
            let mut runtime = EngineRuntime::new(Box::new(io), EngineDeadlines::default());
            for _ in lines {
                runtime.read_line().await.unwrap();
            }
            runtime.diagnostics.clone()
        } else {
            let mut reader = ResumableLineReader::new(BufReader::new(std::io::Cursor::new(
                format!("{}\n", lines.join("\n")).into_bytes(),
            )));
            let diagnostics = Arc::new(Mutex::new(TerminalDiagnostics::default()));
            drain_engine_stderr(&mut reader, &diagnostics).await;
            diagnostics
        }
    }

    #[tokio::test]
    async fn terminal_snapshot_tokenizer_redacts_both_diagnostic_sources() {
        let chess = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1 | 1. e4 e5 2. Nf3 Nc6 +0.42 #3 e2e4";
        let mut cases = Vec::new();
        for quote in ['"', '\''] {
            for key in [
                "token",
                "accessToken",
                "refresh_token",
                "clientSecret",
                "password",
                "passwd",
                "dbPasswd",
                "apiKey",
                "api_key",
                "api-key",
                "X-Api-Key",
                "AcCeSsToKeN",
            ] {
                for separator in [':', '='] {
                    cases.push((
                        format!("{key}{separator}{quote}lip_secret{quote}"),
                        vec!["lip_secret"],
                        true,
                    ));
                }
            }
            let object = format!("{{{quote}accessToken{quote}:{quote}lip_secret{quote}}}");
            cases.push((object.clone(), vec!["lip_secret"], true));
            let mut wrapped = object;
            for _ in 0..2 {
                wrapped = serde_json::to_string(&wrapped).unwrap();
                cases.push((wrapped.clone(), vec!["lip_secret"], true));
            }
            let escaped = format!("\\{quote}");
            for depth in [1, 2, 3, 7] {
                let delimiter = format!("{}{quote}", "\\".repeat(depth));
                cases.push((
                    format!(
                        "{{{delimiter}accessToken{delimiter}:{delimiter}lip_secret{delimiter}}}"
                    ),
                    vec!["lip_secret"],
                    true,
                ));
            }
            cases.push((
                format!("accessToken={escaped}lip_secret{escaped}"),
                vec!["lip_secret"],
                true,
            ));
            for delimiter in [quote.to_string(), escaped.clone()] {
                cases.push((
                    format!("password={delimiter}private pass phrase{delimiter}"),
                    vec!["private", "pass", "phrase"],
                    true,
                ));
                cases.push((
                    format!("password={delimiter}private pass phrase"),
                    vec!["private", "pass", "phrase"],
                    false,
                ));
            }
            cases.push((
                format!("password={quote}private \\{quote}quoted\\{quote} pass phrase{quote}"),
                vec!["private", "quoted", "pass", "phrase"],
                true,
            ));
            let literal = format!("{}{quote}", "\\".repeat(3));
            cases.push((
                format!("password={escaped}private {literal}quoted{literal} pass phrase{escaped}"),
                vec!["private", "quoted", "pass", "phrase"],
                true,
            ));
            cases.push((format!("password={quote}lip_secret{quote} clientSecret={escaped}private pass phrase{escaped}"), vec!["lip_secret", "private", "pass", "phrase"], true));
            cases.push((
                format!("{{{quote}password{quote}:private pass phrase}}"),
                vec!["private", "pass", "phrase"],
                false,
            ));
            cases.push((
                format!("{quote}password=private pass phrase{quote}"),
                vec!["private", "pass", "phrase"],
                false,
            ));
        }
        cases.push((
            "password=private pass phrase".into(),
            vec!["private", "pass", "phrase"],
            false,
        ));
        for (input, fragments, preserve_suffix) in [
            (
                "can't authenticate password=private user's pass phrase",
                vec!["private", "user", "pass", "phrase"],
                false,
            ),
            ("it's token=abc def", vec!["abc", "def"], false),
            ("'password': 'a b'", vec!["a", "b"], true),
            ("{\"msg\":\"don't password=x y\"}", vec!["x", "y"], false),
        ] {
            cases.push((input.into(), fragments, preserve_suffix));
        }
        for form in [
            "Authorization: Bearer lip_secret",
            "Authorization: Basic lip_secret",
            "Bearer lip_secret",
        ] {
            cases.push((form.into(), vec!["lip_secret"], false));
        }
        for (input, fragments, preserve_suffix) in cases {
            for stdout in [true, false] {
                let lines = [
                    format!("CRITICAL ERROR: earlier {input} | {chess}"),
                    format!("CRITICAL ERROR: latest {input} | {chess}"),
                ];
                let diagnostics = terminal_diagnostics_from_lines(&lines, stdout).await;
                let snapshot = diagnostics
                    .lock()
                    .await
                    .snapshot(EngineFailureKind::ProtocolFailure, None);
                let bytes = serde_json::to_string(&snapshot).unwrap();
                let decoded: serde_json::Value = serde_json::from_str(&bytes).unwrap();
                let check = |text: &str| {
                    let later_fragments = chess
                        .split(|ch: char| !ch.is_alphanumeric() && ch != '_')
                        .filter(|word| !word.is_empty() && !preserve_suffix);
                    for fragment in fragments.iter().copied().chain(later_fragments) {
                        assert!(
                            !text
                                .split(|ch: char| !ch.is_alphanumeric() && ch != '_')
                                .any(|word| word == fragment),
                            "source stdout={stdout} input={input:?} leaked {fragment}: {text}"
                        );
                    }
                };
                check(&bytes);
                check(decoded["reason"].as_str().unwrap());
                for prose in ["can't authenticate", "it's", "don't"] {
                    if input.contains(prose) {
                        assert!(decoded["reason"].as_str().unwrap().contains(prose));
                    }
                }
                let entries = decoded["entries"].as_array().unwrap();
                assert_eq!(entries.len(), 2);
                for entry in entries {
                    let text = entry["value"].as_str().unwrap();
                    check(text);
                    assert!(text.contains("CRITICAL ERROR:"));
                    for prose in ["can't authenticate", "it's", "don't"] {
                        if input.contains(prose) {
                            assert!(text.contains(prose));
                        }
                    }
                    assert!(text.contains("[redacted]"));
                    if preserve_suffix {
                        assert!(
                            text.contains(chess),
                            "lost chess notation for {input:?}: {text}"
                        );
                    }
                }
                assert!(decoded["reason"].as_str().unwrap().contains("latest"));
                if preserve_suffix {
                    assert!(decoded["reason"].as_str().unwrap().contains(chess));
                }
            }
        }
    }

    #[tokio::test]
    async fn terminal_snapshot_unquoted_credentials_redact_every_remaining_fragment() {
        let mut input = r#"{"msg":"\"password=private \"quoted\" pass phrase\""}"#.to_owned();
        let chess = "e2e4 1/2-1/2";
        for layer in 0..=2 {
            if layer > 0 {
                input = serde_json::to_string(&input).unwrap();
            }
            for stdout in [true, false] {
                let lines = [
                    format!("CRITICAL ERROR: earlier {chess} {input} aftersecretfragment"),
                    format!("CRITICAL ERROR: latest {chess} {input} aftersecretfragment"),
                ];
                let diagnostics = terminal_diagnostics_from_lines(&lines, stdout).await;
                let snapshot = diagnostics
                    .lock()
                    .await
                    .snapshot(EngineFailureKind::ProtocolFailure, None);
                let bytes = serde_json::to_string(&snapshot).unwrap();
                let decoded: serde_json::Value = serde_json::from_str(&bytes).unwrap();
                let check = |text: &str| {
                    for fragment in ["private", "quoted", "pass", "phrase", "aftersecretfragment"] {
                        assert!(
                            !text
                                .split(|ch: char| !ch.is_alphanumeric() && ch != '_')
                                .any(|word| word == fragment),
                            "source stdout={stdout} layer={layer} input={input:?} leaked {fragment}: {text}"
                        );
                    }
                };
                check(&bytes);
                let reason = decoded["reason"].as_str().unwrap();
                check(reason);
                assert!(reason.contains(&format!("CRITICAL ERROR: latest {chess}")));
                let entries = decoded["entries"].as_array().unwrap();
                assert_eq!(entries.len(), 2);
                for entry in entries {
                    let text = entry["value"].as_str().unwrap();
                    check(text);
                    assert!(text.contains("CRITICAL ERROR:"));
                    assert!(text.contains(chess));
                    assert!(text.ends_with("[redacted]"));
                }
            }
        }
    }

    #[tokio::test]
    async fn terminal_snapshot_wrapped_literal_quotes_never_end_credentials() {
        let chess = "e2e4 1/2-1/2";
        for quote in ['"', '\''] {
            let mut input =
                format!("password={quote}private \\{quote}quoted\\{quote} pass phrase{quote}");
            for layer in 0..=2 {
                if layer > 0 {
                    input = serde_json::to_string(&input).unwrap();
                }
                for stdout in [true, false] {
                    let lines = [
                        format!("CRITICAL ERROR: earlier {input} {chess}"),
                        format!("CRITICAL ERROR: latest {input} {chess}"),
                    ];
                    let diagnostics = terminal_diagnostics_from_lines(&lines, stdout).await;
                    let snapshot = diagnostics
                        .lock()
                        .await
                        .snapshot(EngineFailureKind::ProtocolFailure, None);
                    let bytes = serde_json::to_string(&snapshot).unwrap();
                    let decoded: serde_json::Value = serde_json::from_str(&bytes).unwrap();
                    let check = |text: &str| {
                        for fragment in ["private", "quoted", "pass", "phrase"] {
                            assert!(
                                !text
                                    .split(|ch: char| !ch.is_alphanumeric() && ch != '_')
                                    .any(|word| word == fragment),
                                "source stdout={stdout} layer={layer} input={input:?} leaked {fragment}: {text}"
                            );
                        }
                    };
                    check(&bytes);
                    let reason = decoded["reason"].as_str().unwrap();
                    check(reason);
                    assert!(reason.contains("latest"));
                    assert!(reason.contains(chess), "lost suffix: {reason}");
                    let entries = decoded["entries"].as_array().unwrap();
                    assert_eq!(entries.len(), 2);
                    for entry in entries {
                        let text = entry["value"].as_str().unwrap();
                        check(text);
                        assert!(text.contains("[redacted]"));
                        assert!(text.contains(chess), "lost suffix: {text}");
                    }
                }
            }
        }
    }

    #[tokio::test]
    async fn terminal_snapshot_ambiguous_trailing_backslash_fails_closed() {
        for quote in ['"', '\''] {
            let plain = format!("password={quote}abc\\\\{quote} e2e4 1/2-1/2");
            let exact = format!("{{{quote}password{quote}:{quote}abc{quote}}} e2e4 1/2-1/2");
            for (mut input, preserve_suffix) in [(plain, false), (exact, true)] {
                for layer in 0..=2 {
                    if layer > 0 {
                        input = serde_json::to_string(&input).unwrap();
                    }
                    for stdout in [true, false] {
                        let diagnostics =
                            terminal_diagnostics_from_lines(std::slice::from_ref(&input), stdout)
                                .await;
                        let snapshot = diagnostics
                            .lock()
                            .await
                            .snapshot(EngineFailureKind::ProtocolFailure, None);
                        let bytes = serde_json::to_string(&snapshot).unwrap();
                        assert!(!bytes.contains("abc"), "leaked secret: {bytes}");
                        assert!(snapshot.reason.is_some());
                        assert_eq!(snapshot.entries.len(), 1);
                        for text in snapshot.reason.iter().map(String::as_str).chain(
                            snapshot.entries.iter().map(|entry| match entry {
                                EngineTerminalEntry::InfoString(text)
                                | EngineTerminalEntry::Stderr(text) => text.as_str(),
                                EngineTerminalEntry::Truncated => panic!("unexpected truncation"),
                            }),
                        ) {
                            assert!(text.contains("[redacted]"));
                            assert!(!text.contains("abc"), "leaked secret: {text}");
                            if preserve_suffix {
                                assert!(text.contains("e2e4 1/2-1/2"), "lost suffix: {text}");
                            } else {
                                assert!(!text.contains("e2e4"), "leaked suffix: {text}");
                                assert!(!text.contains("1/2-1/2"), "leaked suffix: {text}");
                            }
                        }
                    }
                }
            }
        }
    }

    #[tokio::test(start_paused = true)]
    async fn terminal_snapshot_unterminated_pending_stdout_survives_recovery() {
        let consumed = Arc::new(AtomicBool::new(false));
        let exit = Arc::new(AtomicBool::new(false));
        let reader = PendingChunkReader::new(
            [b"info string final reason".to_vec()],
            consumed.clone(),
            exit.clone(),
        );
        let mut runtime = EngineRuntime::new(
            Box::new(BufferedBrokenPipeIo {
                reader: ResumableLineReader::new(reader),
                exit_on_terminate: Some(exit),
            }),
            EngineDeadlines::default(),
        );
        assert!(timeout(Duration::from_millis(10), runtime.read_line())
            .await
            .is_err());
        assert!(consumed.load(Ordering::SeqCst));
        let error = recover_failed_protocol::<Option<String>>(
            &mut runtime,
            &OnceLock::new(),
            Err(Error::EngineTimeout("stdout stalled".into())),
        )
        .await
        .unwrap_err();
        assert_eq!(
            error.engine_failure_snapshot().unwrap().reason.as_deref(),
            Some("final reason")
        );
    }

    #[tokio::test]
    async fn terminal_snapshot_mid_line_io_error_preserves_prefix() {
        let mut reader = PendingChunkReader::new(
            [
                b"info string retained prefix ".to_vec(),
                b"info string fabricated\n".to_vec(),
            ],
            Arc::new(AtomicBool::new(false)),
            Arc::new(AtomicBool::new(true)),
        );
        reader.error_after_first_chunk = true;
        let mut runtime = EngineRuntime::new(
            Box::new(BufferedBrokenPipeIo {
                reader: ResumableLineReader::new(reader),
                exit_on_terminate: None,
            }),
            EngineDeadlines::default(),
        );
        let result = runtime.read_line().await;
        assert!(matches!(
            result.as_ref().map_err(operation_cause),
            Err(Error::Io(_))
        ));
        let error = recover_failed_protocol(&mut runtime, &OnceLock::new(), result)
            .await
            .unwrap_err();
        let snapshot = error.engine_failure_snapshot().unwrap();
        assert_eq!(
            snapshot.reason.as_deref(),
            Some("retained prefix info string fabricated")
        );
        assert_eq!(snapshot.entries.len(), 1);
    }

    #[tokio::test]
    async fn terminal_snapshot_oversized_suffix_is_never_a_reason() {
        for next in [None, Some("actual final reason")] {
            let mut input = vec![b'x'; 65_536];
            input.extend_from_slice(b"info string fabricated\n");
            if let Some(reason) = next {
                input.extend_from_slice(format!("info string {reason}\n").as_bytes());
            }
            let mut runtime = EngineRuntime::new(
                Box::new(BufferedBrokenPipeIo {
                    reader: ResumableLineReader::new(BufReader::new(std::io::Cursor::new(input))),
                    exit_on_terminate: None,
                }),
                EngineDeadlines::default(),
            );
            let result = runtime.read_line().await;
            assert!(matches!(
                result.as_ref().map_err(operation_cause),
                Err(Error::ResourceLimit(_))
            ));
            let error = recover_failed_protocol(&mut runtime, &OnceLock::new(), result)
                .await
                .unwrap_err();
            let snapshot = error.engine_failure_snapshot().unwrap();
            assert_eq!(snapshot.reason.as_deref(), next);
            assert!(!serde_json::to_string(snapshot)
                .unwrap()
                .contains("fabricated"));
        }
    }

    #[tokio::test]
    async fn terminal_snapshot_invalid_stdout_has_one_correlated_log() {
        let capture = crate::error::LogCaptureScope::start();
        let mut runtime = EngineRuntime::new(
            Box::new(BufferedBrokenPipeIo {
                reader: ResumableLineReader::new(BufReader::new(std::io::Cursor::new(vec![
                    0xff, b'\n', 0xfe, b'\n', 0xfd, b'\n',
                ]))),
                exit_on_terminate: None,
            }),
            EngineDeadlines::default(),
        );
        let identity = OnceLock::new();
        identity
            .set((
                EngineKey::new("discard-tab".into(), "discard-engine".into()).unwrap(),
                88,
            ))
            .unwrap();
        let result = runtime.ensure_ready(None).await;
        recover_failed_protocol(&mut runtime, &identity, result)
            .await
            .unwrap_err();
        let records = capture
            .records()
            .into_iter()
            .filter(|record| record.message.contains("discarded non-UTF-8"))
            .collect::<Vec<_>>();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].level, log::Level::Error);
        for part in [
            "tab=discard-tab",
            "engine=discard-engine",
            "generation=88",
            "count=3",
        ] {
            assert!(
                records[0].message.contains(part),
                "missing {part}: {}",
                records[0].message
            );
        }
    }

    struct BufferedBrokenPipeIo<R> {
        reader: ResumableLineReader<R>,
        exit_on_terminate: Option<Arc<AtomicBool>>,
    }

    #[async_trait]
    impl<R: AsyncBufRead + Unpin + Send> UciIo for BufferedBrokenPipeIo<R> {
        async fn write_line(&mut self, _: &str) -> Result<(), Error> {
            Err(io::Error::new(io::ErrorKind::BrokenPipe, "closed engine stdin").into())
        }

        async fn read_line(&mut self) -> Result<Option<String>, Error> {
            self.reader.read_line().await
        }

        fn is_discarding_line(&self) -> bool {
            self.reader.is_discarding_line()
        }

        async fn discard_line_remainder(&mut self) -> Result<(), Error> {
            self.reader
                .discard_line_remainder()
                .await
                .map_err(Into::into)
        }

        async fn terminate(&mut self, _: Duration, _: Duration) -> Result<(), Error> {
            if let Some(exit) = &self.exit_on_terminate {
                exit.store(true, Ordering::SeqCst);
            }
            Ok(())
        }
    }

    async fn assert_final_stdout_reason_after_discarded_line(mut input: Vec<u8>) {
        let reason = "CRITICAL ERROR: Command position failed. Reason: invalid";
        input.extend_from_slice(format!("\ninfo string {reason}\n").as_bytes());
        let io = BufferedBrokenPipeIo {
            reader: ResumableLineReader::new(BufReader::new(std::io::Cursor::new(input))),
            exit_on_terminate: None,
        };
        let mut runtime = EngineRuntime::new(Box::new(io), EngineDeadlines::default());
        let result = runtime.ensure_ready(None).await;
        let error = recover_failed_protocol(&mut runtime, &OnceLock::new(), result)
            .await
            .unwrap_err();
        let snapshot = error.engine_failure_snapshot().unwrap();
        assert_eq!(snapshot.reason.as_deref(), Some(reason));
        assert_eq!(
            snapshot.entries,
            vec![EngineTerminalEntry::InfoString(reason.into())]
        );
        assert_eq!(
            runtime
                .logs
                .entries()
                .iter()
                .filter(|entry| matches!(entry, EngineLog::Engine(_)))
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn terminal_snapshot_final_stdout_after_non_utf8_line() {
        assert_final_stdout_reason_after_discarded_line(vec![0xff, 0xfe]).await;
    }

    #[tokio::test]
    async fn terminal_snapshot_final_stdout_after_oversized_line() {
        assert_final_stdout_reason_after_discarded_line(vec![b'x'; MAX_ENGINE_LINE_BYTES + 1])
            .await;
    }

    #[test]
    fn terminal_snapshot_escaped_credential_quotes_are_redacted_in_serialized_bytes() {
        for input in [
            r#"info string {"error":"accessToken=\"lip_secret\""}"#,
            r#"info string {"error":"accessToken=\'lip_secret\'"}"#,
        ] {
            let mut tail = TerminalDiagnostics::default();
            tail.push(input, true);
            let snapshot = tail.snapshot(EngineFailureKind::ProtocolFailure, None);
            let bytes = serde_json::to_string(&snapshot).unwrap();
            assert!(!bytes.contains("lip_secret"), "leaked credential: {bytes}");
            assert!(bytes.contains("[redacted]"));
        }
    }

    #[tokio::test]
    async fn terminal_snapshot_broken_pipe_drains_queued_fatal_stdout() {
        let reason = "CRITICAL ERROR: Command position failed. Reason: invalid";
        let mut io = FakeIo::new(
            Arc::default(),
            [Some(format!("info string {reason}")), None],
        );
        io.fail_write = true;
        let mut runtime = EngineRuntime::new(Box::new(io), EngineDeadlines::default());
        let result = runtime.ensure_ready(None).await;
        let error = recover_failed_protocol(&mut runtime, &OnceLock::new(), result)
            .await
            .unwrap_err();
        assert_eq!(
            error.engine_failure_snapshot().unwrap().reason.as_deref(),
            Some(reason)
        );
        assert!(runtime
            .logs
            .entries()
            .iter()
            .any(|entry| matches!(entry, EngineLog::Engine(line) if line.contains(reason))));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn terminal_snapshot_production_child_broken_pipe_keeps_unread_reason() {
        let directory = tempfile::tempdir().unwrap();
        let script = directory.path().join("fatal.sh");
        let reason = "CRITICAL ERROR: Command position failed. Reason: invalid";
        std::fs::write(
            &script,
            format!("#!/bin/sh\necho 'info string {reason}'\nexit 1\n"),
        )
        .unwrap();
        let executable = EngineExecutable::test_fixture(
            std::fs::File::open(&script).unwrap(),
            directory.path().to_owned(),
            Vec::new(),
        );
        let mut child = Command::new("/bin/sh")
            .arg(&script)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let observed_exit = Arc::new(OnceLock::new());
        let mut control = ProcessChildControl {
            stdin: Some(stdin),
            child,
            observed_exit: observed_exit.clone(),
            kill_started: false,
            terminate_failure: None,
            force_kill_started: false,
        };
        // Await the real child exit without consuming stdout. The next actor
        // write is now deterministically EPIPE, with the fatal line still queued.
        timeout(Duration::from_secs(2), control.wait())
            .await
            .unwrap()
            .unwrap();
        let cleanup = Arc::new(ChildOwner::default());
        {
            let mut state = cleanup.state.lock().unwrap();
            state.control = Some(Box::new(control));
            state.executable = Some(executable);
        }
        let actor = EngineActor::new(
            Box::new(ChildUciIo {
                cleanup,
                line_reader: ResumableLineReader::new(BufReader::new(stdout)),
                observed_exit,
            }),
            EngineDeadlines::default(),
        );
        let error = actor.ensure_ready().await.unwrap_err();
        // The fork/exec fd-inheritance race can let the write succeed before stdout EOF.
        assert!(match operation_cause(&error) {
            Error::Io(error) => error.kind() == io::ErrorKind::BrokenPipe,
            Error::EngineDisconnected => true,
            _ => false,
        });
        assert_eq!(
            error.engine_failure_snapshot().unwrap().reason.as_deref(),
            Some(reason)
        );
        assert_eq!(
            error
                .engine_failure_snapshot()
                .unwrap()
                .exit_status
                .unwrap()
                .code,
            Some(1)
        );
        actor.terminate().await.unwrap();
    }

    #[test]
    fn terminal_snapshot_compound_credentials_are_redacted_in_serialized_bytes() {
        let chess = "token is a word. 1. e4 e5 2. Nf3 Nc6 +0.42 #3 e2e4";
        let raw = format!(
            r#"{{"accessToken":"access-value"}} refresh_token="refresh-value" apiKey: "api-value" clientSecret="client-value" Authorization: "Bearer bearer-value" X-Api-Key: "header-value" PASSWORD="pass-value" dbPasswd="passwd-value" Authorization: "Basic basic-value" Bearer "bare-value" {chess}"#
        );
        let mut tail = TerminalDiagnostics::default();
        tail.push(&raw, true);
        let snapshot = tail.snapshot(EngineFailureKind::ProtocolFailure, None);
        let bytes = serde_json::to_string(&snapshot).unwrap();
        for secret in [
            "access-value",
            "refresh-value",
            "api-value",
            "client-value",
            "bearer-value",
            "header-value",
            "pass-value",
            "passwd-value",
            "basic-value",
            "bare-value",
        ] {
            assert!(!bytes.contains(secret), "leaked {secret}: {bytes}");
        }
        assert!(bytes.contains(chess));
    }

    #[tokio::test]
    async fn terminal_snapshot_supervisor_starts_a_fresh_generation() {
        terminal_restart_case(true).await;
    }

    #[tokio::test]
    async fn terminal_snapshot_supervisor_never_reuses_a_terminal_actor() {
        terminal_restart_case(false).await;
    }

    async fn terminal_restart_case(stop_first: bool) {
        let supervisor = Arc::new(EngineSupervisor::default());
        let key =
            EngineKey::new(format!("terminal-restart-{stop_first}"), "engine".into()).unwrap();
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("engine");
        std::fs::write(&file, b"test engine").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        let mut authority = PathAuthority::open_for_engine_test(directory.path()).unwrap();
        let engine = authority
            .register_engine_file(&file, "terminal restart")
            .unwrap();
        let options = crate::chess::EngineOptions {
            fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1".into(),
            ..Default::default()
        };
        let (actor, _) =
            EngineActor::recording_test_actor(&["uciok", "readyok", "info string failure from A"]);
        let old = supervisor
            .replace_handle(
                key.clone(),
                actor.clone(),
                key.engine.clone(),
                engine.id.clone(),
            )
            .await
            .unwrap();
        *old.interactive.lock().await = Some(
            crate::chess::WarmEngine::new(actor.clone(), Vec::new(), &AtomicBool::new(false))
                .await
                .unwrap(),
        );
        let search = SupervisedSearch::new(old.generation, Arc::new(AtomicBool::new(false)));
        old.bind_search(search);
        let request = actor.start_search(&GoMode::Depth(1)).await.unwrap();
        actor.next_search_line(request).await.unwrap();
        assert_eq!(
            actor
                .next_search_line(request)
                .await
                .unwrap_err()
                .engine_failure_snapshot()
                .unwrap()
                .reason
                .as_deref(),
            Some("failure from A")
        );
        if stop_first {
            assert!(!supervisor
                .stop_or_release(&key, Some(old.generation), false)
                .await
                .unwrap());
            assert!(supervisor.get_exact(&key).is_none());
        }
        let fresh = EngineActor::new(
            Box::new(FakeIo::new(
                Arc::default(),
                [
                    Some("uciok".into()),
                    Some("readyok".into()),
                    Some("readyok".into()),
                ],
            )),
            EngineDeadlines::default(),
        );
        let _override = SpawnActorOverrideGuard::new(fresh);
        let admission = supervisor
            .admit(key.clone(), key.engine.clone(), engine.id.clone(), false)
            .await
            .unwrap();
        let (_, current, _) = supervisor
            .start_interactive_search(
                key.clone(),
                engine,
                crate::infra::path_authority::SharedPathAuthority::installed(authority),
                admission,
                options,
                &GoMode::Depth(1),
            )
            .await
            .unwrap();
        assert_ne!(current.generation, old.generation);
        assert!(!Arc::ptr_eq(&current.actor, &actor));
        assert!(current.actor.terminal_snapshot().is_none());
        supervisor.terminate_all().await.unwrap();
    }

    #[tokio::test]
    async fn terminal_snapshot_stale_cleanup_cannot_remove_a_replacement() {
        let supervisor = EngineSupervisor::default();
        let key = EngineKey::new("terminal-stale".into(), "engine".into()).unwrap();
        let (old_actor, _) =
            EngineActor::recording_test_actor(&["info string old terminal reason"]);
        let old = supervisor
            .replace_handle(
                key.clone(),
                old_actor.clone(),
                key.engine.clone(),
                path_ref("old-terminal"),
            )
            .await
            .unwrap();
        let request = old_actor.start_search(&GoMode::Depth(1)).await.unwrap();
        old_actor.next_search_line(request).await.unwrap();
        let error = old_actor.next_search_line(request).await.unwrap_err();
        let (replacement, _) = EngineActor::recording_test_actor(&[]);
        let current = supervisor
            .replace_handle(
                key.clone(),
                replacement.clone(),
                key.engine.clone(),
                path_ref("replacement-terminal"),
            )
            .await
            .unwrap();
        supervisor
            .release_generation(&key, old.generation)
            .await
            .unwrap();
        assert_eq!(
            supervisor.get_exact(&key).unwrap().generation,
            current.generation
        );
        assert_eq!(
            error.engine_failure_snapshot().unwrap().reason.as_deref(),
            Some("old terminal reason")
        );
        assert_eq!(
            old_actor.terminal_snapshot(),
            error.engine_failure_snapshot()
        );
        assert!(replacement.terminal_snapshot().is_none());
        supervisor.terminate_all().await.unwrap();
    }

    #[test]
    fn terminal_snapshot_entry_count_includes_the_truncation_marker() {
        let mut diagnostics = TerminalDiagnostics::default();
        for index in 0..100 {
            diagnostics.push(&format!("line {index}"), false);
        }
        let snapshot = diagnostics.snapshot(EngineFailureKind::Disconnected, None);
        assert_eq!(snapshot.entries.len(), MAX_TERMINAL_ENTRIES);
        assert_eq!(
            snapshot.entries.first(),
            Some(&EngineTerminalEntry::Truncated)
        );
        assert_eq!(snapshot.reason.as_deref(), Some("line 99"));
    }
    #[test]
    fn terminal_snapshot_sanitizes_quoted_paths_credentials_and_chess_notation() {
        let input = "e2e4 1/2-1/2 4k3/8/8/8/8/8/8/4K3 CRITICAL ERROR password=\"private pass phrase\" token=\u{2003}hidden '/private/My Book.bin' \"C:\\private\\My Book.bin\"";
        let mut diagnostics = TerminalDiagnostics::default();
        diagnostics.push(input, true);
        let bytes =
            serde_json::to_string(&diagnostics.snapshot(EngineFailureKind::ProtocolFailure, None))
                .unwrap();
        for secret in ["private", "Book.bin", "phrase", "hidden"] {
            assert!(!bytes.contains(secret), "{bytes}");
        }
        assert!(bytes.contains("e2e4 1/2-1/2 4k3/8/8/8/8/8/8/4K3 CRITICAL ERROR"));
    }

    #[cfg(unix)]
    #[test]
    fn terminal_snapshot_unix_observed_signal_has_no_exit_code() {
        use std::os::unix::process::ExitStatusExt;
        assert_eq!(
            observed_exit_status(std::process::ExitStatus::from_raw(libc::SIGTERM)),
            EngineExitStatus {
                code: None,
                signal: Some(libc::SIGTERM)
            }
        );
    }
    fn operation_cause(error: &Error) -> &Error {
        match error {
            Error::EngineFailure { cause, .. } => operation_cause(cause),
            Error::Shared(error) => operation_cause(error),
            error => error,
        }
    }
    #[tokio::test]
    async fn terminal_snapshot_selects_info_then_stderr_then_kind() {
        for (info, stderr, expected) in [
            (
                Some("command e2e4 rejected"),
                Some("stderr last"),
                Some("command e2e4 rejected"),
            ),
            (None, Some("stderr last"), Some("stderr last")),
            (Some("  "), None, None),
        ] {
            let runtime = EngineRuntime::new(
                Box::new(FakeIo::new(Arc::default(), [])),
                EngineDeadlines::default(),
            );
            if let Some(text) = info {
                runtime.diagnostics.lock().await.push(text, true);
            }
            if let Some(text) = stderr {
                runtime.diagnostics.lock().await.push(text, false);
            }
            let actor = EngineActor::from_runtime(runtime);
            let error = actor.ensure_ready().await.unwrap_err();
            let snapshot = actor.terminal_snapshot().unwrap();
            assert_eq!(snapshot.reason.as_deref(), expected);
            assert_eq!(snapshot.kind, EngineFailureKind::Disconnected);
            assert_eq!(snapshot.exit_status, None);
            assert_eq!(error.engine_failure_snapshot(), Some(snapshot));
            actor.terminate().await.unwrap();
            assert_eq!(actor.terminal_snapshot(), Some(snapshot));
        }
    }

    #[tokio::test]
    async fn terminal_snapshot_native_bytes_are_bounded_and_redacted_after_late_provenance() {
        let mut runtime = EngineRuntime::new(Box::new(FakeIo::new(Arc::default(), [Some("info string echo opaque-resource-token password=\"hidden\" /private/book.bin e2e4 1/2-1/2 4k3/8/8/8/8/8/8/4K3".into())])), EngineDeadlines::default());
        runtime.read_line().await.unwrap();
        runtime
            .set_option_with_resources(
                "Book",
                "opaque-resource-token",
                &["opaque-resource-token".into()],
                None,
                None,
            )
            .await
            .unwrap();
        runtime.diagnostics.lock().await.push("stderr Bearer \"hidden2\" C:\\private\\book.bin \\\\server\\private ~/private/book.bin ./private/book.bin {\"token\":\"hidden3\"}", false);
        let error = recover_failed_protocol::<()>(
            &mut runtime,
            &OnceLock::new(),
            Err(disconnected_failure()),
        )
        .await
        .unwrap_err();
        let bytes = serde_json::to_string(&error).unwrap();
        for secret in ["opaque-resource-token", "hidden", "private", "server"] {
            assert!(!bytes.contains(secret), "{bytes}");
        }
        assert!(bytes.contains("e2e4 1/2-1/2 4k3/8/8/8/8/8/8/4K3"));
        assert!(bytes.contains("[redacted]"));
        assert!(bytes.contains("[path]"));

        let mut diagnostics = TerminalDiagnostics::default();
        for _ in 0..100 {
            diagnostics.push(&"棋\"".repeat(1000), false);
        }
        diagnostics.push(&"ä".repeat(2048), true);
        let snapshot = diagnostics.snapshot(EngineFailureKind::ProtocolFailure, None);
        assert!(snapshot.reason.as_ref().unwrap().len() <= MAX_TERMINAL_REASON_BYTES);
        assert!(snapshot.reason.as_ref().unwrap().ends_with("… [truncated]"));
        assert!(snapshot.entries.len() <= MAX_TERMINAL_ENTRIES);
        assert!(serde_json::to_vec(&snapshot.entries).unwrap().len() <= MAX_TERMINAL_BYTES);
        assert!(matches!(
            snapshot.entries.first(),
            Some(EngineTerminalEntry::Truncated)
        ));
        let serialized = serde_json::to_vec(&snapshot).unwrap();
        let _: serde_json::Value = serde_json::from_slice(&serialized).unwrap();
    }

    #[tokio::test]
    async fn terminal_snapshot_stderr_tail_survives_exhausted_logging_budget() {
        let mut input = vec![];
        for _ in 0..20 {
            input.extend_from_slice(&vec![b'x'; MAX_ENGINE_LINE_BYTES / 2]);
            input.push(b'\n');
        }
        input.extend_from_slice(b"terminal stderr token=\"secret\" /private/book.bin\n");
        let mut reader = ResumableLineReader::new(BufReader::new(std::io::Cursor::new(input)));
        let diagnostics = Mutex::new(TerminalDiagnostics::default());
        drain_engine_stderr(&mut reader, &diagnostics).await;
        let snapshot = diagnostics
            .lock()
            .await
            .snapshot(EngineFailureKind::Disconnected, None);
        assert_eq!(
            snapshot.reason.as_deref(),
            Some("terminal stderr token=\"[redacted]\" [path]")
        );
        let bytes = serde_json::to_string(&snapshot).unwrap();
        assert!(!bytes.contains("secret"));
        assert!(!bytes.contains("private"));
    }

    struct ObservedExitIo {
        status: EngineExitStatus,
    }
    #[async_trait]
    impl UciIo for ObservedExitIo {
        fn observed_exit(&self) -> Option<EngineExitStatus> {
            Some(self.status)
        }
        async fn write_line(&mut self, _: &str) -> Result<(), Error> {
            Ok(())
        }
        async fn read_line(&mut self) -> Result<Option<String>, Error> {
            Ok(None)
        }
        async fn terminate(&mut self, _: Duration, _: Duration) -> Result<(), Error> {
            Ok(())
        }
    }

    #[tokio::test]
    async fn terminal_snapshot_observed_nonzero_exit_does_not_mean_failed_reap() {
        let status = EngineExitStatus {
            code: Some(17),
            signal: None,
        };
        let actor = EngineActor::new(
            Box::new(ObservedExitIo { status }),
            EngineDeadlines::default(),
        );
        let error = actor.init_uci().await.unwrap_err();
        let snapshot = error.engine_failure_snapshot().unwrap();
        assert_eq!(snapshot.kind, EngineFailureKind::ProcessExit);
        assert_eq!(snapshot.exit_status, Some(status));
        assert!(snapshot.reason.is_none());
        actor.terminate().await.unwrap();
        assert_eq!(actor.terminal_snapshot(), Some(snapshot));
    }

    #[tokio::test]
    async fn terminal_snapshot_intentional_interruption_is_not_a_crash() {
        let mut io = FakeIo::new(Arc::default(), []);
        io.pending_when_empty = true;
        let actor = Arc::new(EngineActor::new(Box::new(io), EngineDeadlines::default()));
        let requested = tokio::spawn({
            let actor = actor.clone();
            async move { actor.init_uci().await }
        });
        tokio::task::yield_now().await;
        actor.terminate().await.unwrap();
        assert!(matches!(
            requested.await.unwrap(),
            Err(Error::EngineDisconnected)
        ));
        assert!(actor.terminal_snapshot().is_none());
    }

    #[tokio::test]
    async fn terminal_snapshot_preserves_cleanup_failure_and_shared_error_without_egress() {
        let mut io = FakeIo::new(Arc::default(), []);
        io.termination_error = Some(Arc::new(Error::Io(Box::new(std::io::Error::other(
            "/private/cleanup token=secret",
        )))));
        let actor = EngineActor::new(Box::new(io), EngineDeadlines::default());
        let error = actor.init_uci().await.unwrap_err();
        assert_ne!(error.category(), crate::error::ErrorCategory::Cancellation);
        assert!(error.diagnostic().contains("/private/cleanup"));
        assert!(error.engine_failure_snapshot().is_some());
        assert!(actor.terminate().await.is_err());
        let shared = Error::Shared(Arc::new(error));
        let wrapped =
            Error::with_cleanup(shared, Err(Error::Conflict("second native cleanup".into())));
        assert!(wrapped.engine_failure_snapshot().is_some());
        assert!(wrapped.diagnostic().contains("second native cleanup"));
        let bytes = serde_json::to_string(&wrapped).unwrap();
        assert!(!bytes.contains("private"));
        assert!(!bytes.contains("secret"));
        assert!(!bytes.contains("second native cleanup"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn terminal_snapshot_production_child_exit_during_initialization() {
        let directory = tempfile::tempdir().unwrap();
        let script = directory.path().join("terminal-engine.sh");
        crate::infra::test_executable::publish_test_executable(&script, "#!/bin/sh\nIFS= read -r line\necho 'stderr token=\"hidden\" /private/book.bin' >&2\necho 'info string CRITICAL ERROR: e2e4 rejected password=hidden2'\nexit 17\n", 0o700).unwrap();
        let executable = EngineExecutable::test_fixture(
            std::fs::File::open(&script).unwrap(),
            directory.path().to_path_buf(),
            Vec::new(),
        );
        let actor = EngineActor::spawn(executable, EngineDeadlines::default())
            .await
            .unwrap();
        let error = actor.init_uci().await.unwrap_err();
        let snapshot = actor.terminal_snapshot().unwrap();
        assert_eq!(snapshot.kind, EngineFailureKind::ProcessExit);
        assert_eq!(
            snapshot.exit_status,
            Some(EngineExitStatus {
                code: Some(17),
                signal: None
            })
        );
        assert_eq!(
            snapshot.reason.as_deref(),
            Some("CRITICAL ERROR: e2e4 rejected password=[redacted]")
        );
        assert!(snapshot.entries.iter().any(|entry| matches!(entry, EngineTerminalEntry::Stderr(text) if text == "stderr token=\"[redacted]\" [path]")));
        let bytes = serde_json::to_string(&error).unwrap();
        assert!(!bytes.contains("private"));
        assert!(!bytes.contains("hidden"));
        actor.terminate().await.unwrap();
    }

    #[tokio::test]
    async fn set_position_writes_only_the_canonical_root_and_normalized_moves() {
        let (actor, writes) = EngineActor::recording_test_actor(&[]);
        actor
            .set_position(
                "r3k2r/8/8/8/8/8/8/R3K2R_w_HAha_-_-1_200000",
                &["e1h1".into(), "e8a8".into()],
            )
            .await
            .unwrap();
        assert_eq!(
            *writes.lock().await,
            ["position fen r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 100000 moves e1g1 e8c8"]
        );
        actor.terminate().await.unwrap();
    }

    #[tokio::test]
    async fn set_position_rejection_writes_nothing() {
        let (actor, writes) = EngineActor::recording_test_actor(&[]);
        for (fen, moves) in [
            ("4k3/8/8/8/8/8/PPPPPPPP/QQQ1K3 w - - 0 1", vec![]),
            (
                "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
                vec!["e2e5".into()],
            ),
        ] {
            assert!(matches!(
                actor.set_position(fen, &moves).await,
                Err(Error::EnginePositionRejected(_))
            ));
        }
        assert!(writes.lock().await.is_empty());
        actor.terminate().await.unwrap();
    }
    /// A real child process, spawned exactly the way production spawns an engine,
    /// must read the authorized executable/resource pinned for this launch — not whatever
    /// visible path resolves to once the option is applied. The fixture is a shebang script on
    /// purpose: it exercises the child-visible launch target, including wrapper-script engines.
    #[cfg(unix)]
    #[tokio::test]
    async fn authorized_resource_survives_path_replacement_for_uci_child() {
        let directory = tempfile::tempdir().unwrap();
        let script = directory.path().join("uci-child.sh");
        // Echoes back the file the `setoption` value points at, so the assertion
        // below reads the bytes the child itself resolved.
        crate::infra::test_executable::publish_test_executable(
            &script,
            "#!/bin/sh\nwhile IFS= read -r line; do case \"$line\" in uci) echo uciok;; isready) echo readyok;; setoption*) p=${line#*value }; cat \"$p\";; quit) exit 0;; esac; done\n", 0o700)
        .unwrap();
        let resource = directory.path().join("resource.bin");
        // The trailing newline matters: the child pipes `cat` output straight into
        // the UCI line protocol, so an unterminated body would fuse with `readyok`.
        std::fs::write(&resource, b"pinned-bytes\n").unwrap();
        let lease = crate::infra::path_authority::EngineResourceLease::test_file(
            std::fs::File::open(&resource).unwrap(),
        );
        let executable = crate::infra::path_authority::EngineExecutable::test_fixture(
            std::fs::File::open(&script).unwrap(),
            directory.path().to_path_buf(),
            vec![lease],
        );
        #[cfg(target_os = "macos")]
        let mut executable = executable;
        #[cfg(target_os = "macos")]
        {
            let root =
                crate::infra::path_authority::EngineLaunchRoot::for_test(directory.path()).unwrap();
            executable.set_test_launch_root(root);
            let key = EngineKey::new("resource-test".into(), "engine".into()).unwrap();
            pin_engine_launch(&mut executable, &key, "engine", &|| false).unwrap();
        }
        // Use the production UCI value handed to `setoption`, not a hand-built path.
        let uci_value = executable.resource_leases()[0].uci_value().unwrap();
        let actor = EngineActor::spawn_initialized(executable, EngineDeadlines::default())
            .await
            .unwrap();

        // Replace the resource behind its visible path after the engine is live.
        std::fs::remove_file(&resource).unwrap();
        std::fs::write(&resource, b"replacement-bytes\n").unwrap();
        assert_eq!(
            std::fs::read_to_string(&resource).unwrap(),
            "replacement-bytes\n",
            "the visible path must really have been replaced for this test to mean anything",
        );

        actor
            .set_option_with_resources("Book", &uci_value, std::slice::from_ref(&uci_value))
            .await
            .unwrap();
        actor.ensure_ready().await.unwrap();
        let engine_lines: Vec<String> = actor
            .logs()
            .await
            .unwrap()
            .iter()
            .filter_map(|entry| match entry {
                EngineLog::Engine(line) => Some(line.trim().to_owned()),
                _ => None,
            })
            .collect();
        assert!(
            engine_lines.iter().any(|line| line == "pinned-bytes"),
            "child did not read the authorized inode; engine output was {engine_lines:?}",
        );
        assert!(
            !engine_lines.iter().any(|line| line == "replacement-bytes"),
            "child followed the replaced path; engine output was {engine_lines:?}",
        );
        assert!(actor.logs().await.unwrap().iter().all(|entry| match entry {
            EngineLog::Gui(line) | EngineLog::Engine(line) => !line.contains(&uci_value),
            EngineLog::Truncated { .. } => true,
        }));
        actor.terminate().await.unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn child_uci_io_preserves_a_partial_line_across_a_dropped_runtime_read() {
        let directory = tempfile::tempdir().unwrap();
        let script = directory.path().join("partial-line-engine.sh");
        let marker = directory.path().join("partial-ready");
        let release = directory.path().join("release");
        crate::infra::test_executable::publish_test_executable(
            &script,
            format!(
                "#!/bin/sh\nwhile IFS= read -r line; do case \"$line\" in go*) printf 'partial '; : > '{}'; while [ ! -e '{}' ]; do sleep 0.01; done; printf 'line\\n';; quit) exit 0;; esac; done\n",
                marker.display(),
                release.display()
            ), 0o700)
        .unwrap();
        let executable = EngineExecutable::test_fixture(
            std::fs::File::open(&script).unwrap(),
            directory.path().to_path_buf(),
            Vec::new(),
        );
        let mut runtime = EngineRuntime::spawn(executable, EngineDeadlines::default())
            .await
            .unwrap();
        if let Err(error) = runtime.start_search(&GoMode::Depth(1), None).await {
            let _ = runtime.terminate().await;
            panic!("partial-line engine search failed to start: {error}");
        }

        let outcome = async {
            tokio::time::timeout(Duration::from_secs(1), async {
                while !marker.exists() {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .map_err(|_| "the child did not publish its partial-line marker".to_owned())?;

            let completed_before_release = {
                let read = runtime.read_line();
                tokio::pin!(read);
                tokio::time::timeout(Duration::from_millis(200), &mut read)
                    .await
                    .is_ok()
            };
            if completed_before_release {
                return Err("the first runtime read completed before release".to_owned());
            }
            std::fs::write(&release, b"release\n")
                .map_err(|error| format!("failed to release the child: {error}"))?;
            let line = tokio::time::timeout(Duration::from_secs(1), runtime.read_line())
                .await
                .map_err(|_| "the resumed runtime read timed out".to_owned())?
                .map_err(|error| format!("the resumed runtime read failed: {error}"))?;
            if line.as_deref() != Some("partial line") {
                return Err(format!("unexpected resumed line: {line:?}"));
            }
            Ok::<(), String>(())
        }
        .await;
        let termination = runtime.terminate().await;
        assert!(termination.is_ok(), "partial-line child must be reaped");
        outcome.unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn spawned_engine_reads_a_directory_resource_through_the_authorized_value() {
        let directory = tempfile::tempdir().unwrap();
        let script = directory.path().join("directory-child.sh");
        crate::infra::test_executable::publish_test_executable(
            &script,
            "#!/bin/sh\nwhile IFS= read -r line; do case \"$line\" in uci) echo uciok;; isready) echo readyok;; setoption*) value=${line#*value }; cat \"$value/authorized\";; quit) exit 0;; esac; done\n", 0o700)
        .unwrap();
        let resource_path = directory.path().join("tables");
        std::fs::create_dir(&resource_path).unwrap();
        std::fs::write(resource_path.join("authorized"), b"directory-authorized\n").unwrap();
        let resource_file = std::fs::File::open(&resource_path).unwrap();
        #[cfg(target_os = "macos")]
        let resource =
            crate::infra::path_authority::EngineResourceLease::test_directory(resource_file);
        #[cfg(target_os = "linux")]
        let resource = crate::infra::path_authority::EngineResourceLease::test_file(resource_file);
        let resource = Arc::new(resource);
        let value = resource.uci_value().unwrap();
        let image = std::fs::File::open(&script).unwrap();
        let executable = crate::infra::path_authority::EngineExecutable::test_fixture(
            image,
            directory.path().to_path_buf(),
            vec![],
        )
        .with_resource_leases(vec![resource.clone()]);
        #[cfg(target_os = "macos")]
        let mut executable = executable;
        #[cfg(target_os = "macos")]
        {
            executable.set_test_launch_root(
                crate::infra::path_authority::EngineLaunchRoot::for_test(directory.path()).unwrap(),
            );
            let key = EngineKey::new("directory-test".into(), "engine".into()).unwrap();
            pin_engine_launch(&mut executable, &key, "engine", &|| false).unwrap();
        }
        let actor = EngineActor::spawn_initialized(executable, EngineDeadlines::default())
            .await
            .unwrap();
        #[cfg(target_os = "linux")]
        {
            std::fs::rename(&resource_path, directory.path().join("tables-original")).unwrap();
            std::fs::create_dir(&resource_path).unwrap();
            std::fs::write(resource_path.join("replacement"), b"replacement\n").unwrap();
        }
        let options = [ResolvedEngineOption {
            name: "SyzygyPath".into(),
            value: value.clone(),
            resources: vec![resource],
            resource_values: vec![value.clone()],
        }];
        verify_option_resources(&actor, &options, None)
            .await
            .unwrap();
        actor
            .set_option_with_resources("SyzygyPath", &value, std::slice::from_ref(&value))
            .await
            .unwrap();
        assert_eq!(
            actor.next_configuration_line().await.unwrap(),
            Some("directory-authorized".into())
        );
        actor.terminate().await.unwrap();
    }

    #[cfg(any(windows, target_os = "macos"))]
    async fn spawn_native_probe(executable: EngineExecutable) -> (EngineRuntime, Arc<ChildOwner>) {
        let deadlines = EngineDeadlines {
            quit: Duration::from_millis(20),
            ..EngineDeadlines::default()
        };
        let cleanup = Arc::new(ChildOwner::default());
        let runtime = match EngineRuntime::spawn_owned(
            executable,
            deadlines.clone(),
            cleanup.clone(),
        )
        .await
        {
            Ok(runtime) => runtime,
            Err(error) => {
                let reaped = cleanup
                    .terminate(Duration::ZERO, deadlines.kill_reap, false)
                    .await;
                assert!(
                    reaped.is_ok(),
                    "failed native launch must be reaped: {reaped:?}"
                );
                panic!("native launch failed: {error:?}");
            }
        };
        (runtime, cleanup)
    }

    #[cfg(any(windows, target_os = "macos"))]
    async fn reap_native_probe(runtime: &mut EngineRuntime, cleanup: &ChildOwner) {
        let reaped = runtime.terminate().await;
        let fallback = cleanup
            .terminate(Duration::ZERO, runtime.deadlines.kill_reap, false)
            .await;
        assert!(reaped.is_ok(), "native probe must be reaped: {reaped:?}");
        assert!(
            fallback.is_ok(),
            "native probe fallback must confirm reap: {fallback:?}"
        );
        assert!(!cleanup.unresolved());
        eprintln!("native probe physically reaped before propagating outcome");
    }

    #[cfg(any(windows, target_os = "macos"))]
    async fn assert_native_cwd_probe(executable: EngineExecutable, command: &str) {
        let (mut runtime, cleanup) = spawn_native_probe(executable).await;
        let outcome = timeout(Duration::from_secs(5), async {
            runtime.send(command, None).await?;
            loop {
                let line = runtime
                    .read_line()
                    .await?
                    .ok_or(Error::EngineDisconnected)?;
                let line = line.trim();
                if line == "cwd-original" || line == "cwd-replacement" {
                    return Ok::<_, Error>(line.to_owned());
                }
            }
        })
        .await;
        reap_native_probe(&mut runtime, &cleanup).await;
        assert_eq!(outcome.unwrap().unwrap(), "cwd-original");
    }

    #[cfg(windows)]
    struct WindowsResourceProbe {
        _temp: tempfile::TempDir,
        executable: EngineExecutable,
        resources: Vec<(String, std::path::PathBuf, &'static str)>,
        rename_paths: Vec<std::path::PathBuf>,
    }

    #[cfg(windows)]
    fn windows_resource_probe() -> WindowsResourceProbe {
        use crate::infra::path_authority::{EngineResourceHandleKind, PathClass};

        let temp = tempfile::tempdir().unwrap();
        let cwd = temp.path().join("engine-cwd");
        std::fs::create_dir(&cwd).unwrap();
        let image = cwd.join("engine.exe");
        std::fs::copy(std::env::var_os("COMSPEC").unwrap(), &image).unwrap();
        let ancestor = temp.path().join("resource-ancestor");
        let parent = ancestor.join("resource-parent");
        let directory = parent.join("tables");
        std::fs::create_dir_all(&directory).unwrap();
        let file = parent.join("book.bin");
        std::fs::write(&file, b"resource-file-original\n").unwrap();
        std::fs::write(directory.join("data"), b"resource-directory-original\n").unwrap();
        let mut authority = PathAuthority::open(temp.path().join("registry.json"), vec![]).unwrap();
        let engine = authority
            .register_engine_file(&image, "Resource seal probe")
            .unwrap();
        let mut leases = Vec::new();
        let mut resources = Vec::new();
        for (path, kind, content) in [
            (
                &file,
                EngineResourceHandleKind::File,
                "resource-file-original",
            ),
            (
                &directory,
                EngineResourceHandleKind::Directory,
                "resource-directory-original",
            ),
        ] {
            let grant = authority
                .grant_dialog(
                    path,
                    "resource",
                    PathClass::SingleDialogGrant,
                    PathOperation::EngineResourceRead,
                    Duration::from_secs(30),
                    1,
                )
                .unwrap();
            let read_path = if kind == EngineResourceHandleKind::Directory {
                path.join("data")
            } else {
                path.to_path_buf()
            };
            let handle = authority
                .promote_engine_resource(&grant, kind, "resource")
                .unwrap();
            let lease = authority.engine_resource(&handle).unwrap();
            let value = lease.uci_value().unwrap();
            resources.push((value, read_path, content));
            leases.push(Arc::new(lease));
        }
        let executable = authority
            .engine_executable(&engine, PathOperation::EngineExecute)
            .unwrap()
            .with_resource_leases(leases);
        WindowsResourceProbe {
            _temp: temp,
            executable,
            resources,
            rename_paths: vec![file, directory, parent, ancestor],
        }
    }

    #[cfg(windows)]
    fn assert_resource_renames_released(paths: &[std::path::PathBuf]) {
        for path in paths {
            let moved = path.with_extension("moved");
            std::fs::rename(path, &moved)
                .expect("physical reap must release child-only resource seals");
            std::fs::rename(&moved, path).unwrap();
        }
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn windows_resource_child_seals_survive_all_backend_seal_loss_until_reap() {
        let WindowsResourceProbe {
            _temp,
            executable,
            resources,
            rename_paths,
        } = windows_resource_probe();
        let (mut runtime, cleanup) = spawn_native_probe(executable).await;
        let outcome = std::panic::AssertUnwindSafe(async {
            // No EngineActor or local Arc retains resources here. This removes the sole
            // backend executable/resource owner while leaving child control available.
            let backend_seals = cleanup.state.lock().unwrap().executable.take().unwrap();
            drop(backend_seals);
            for path in &rename_paths {
                let moved = path.with_extension("moved");
                let error = std::fs::rename(path, &moved)
                    .expect_err("child-only seals must refuse resource/parent/ancestor rename");
                assert!(matches!(error.raw_os_error(), Some(5 | 32)), "{error}");
                assert!(!moved.exists());
                for (_, read_path, content) in &resources {
                    assert_eq!(std::fs::read_to_string(read_path).unwrap().trim(), *content);
                }
            }
            for (value, _, content) in &resources {
                let resource_path = if *content == "resource-directory-original" {
                    format!("{value}\\data")
                } else {
                    value.clone()
                };
                timeout(Duration::from_secs(5), async {
                    runtime
                        .send(&format!("type \"{resource_path}\""), None)
                        .await?;
                    loop {
                        let line = runtime
                            .read_line()
                            .await?
                            .ok_or(Error::EngineDisconnected)?;
                        if line.trim() == *content {
                            return Ok::<_, Error>(());
                        }
                    }
                })
                .await
                .unwrap()
                .unwrap();
            }
        })
        .catch_unwind()
        .await;
        reap_native_probe(&mut runtime, &cleanup).await;
        if let Err(panic) = outcome {
            std::panic::resume_unwind(panic);
        }
        assert_resource_renames_released(&rename_paths);
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn windows_resource_partial_transfer_failure_precedes_protocol_and_is_reaped() {
        let WindowsResourceProbe {
            _temp,
            executable,
            rename_paths,
            ..
        } = windows_resource_probe();
        let cleanup = Arc::new(ChildOwner::default());
        SPAWN_RESOURCE_TRANSFER_OBSERVED.with(|slot| slot.set(Some((0, 0))));
        set_spawn_io_failure(Some(SpawnIoFailure::ResourceTransferAfter(1)));
        let result =
            EngineRuntime::spawn_owned(executable, EngineDeadlines::default(), cleanup.clone())
                .await;
        let owned = cleanup.unresolved();
        let observed = SPAWN_RESOURCE_TRANSFER_OBSERVED.with(|slot| slot.take());
        set_spawn_io_failure(None);
        let error = match result {
            Ok(mut runtime) => {
                reap_native_probe(&mut runtime, &cleanup).await;
                None
            }
            Err(error) => Some(error),
        };
        let reaped = cleanup
            .terminate(Duration::ZERO, EngineDeadlines::default().kill_reap, false)
            .await;
        assert!(
            reaped.is_ok(),
            "partial transfer child must be physically reaped: {reaped:?}"
        );
        assert!(!cleanup.unresolved());
        eprintln!("partial transfer child physically reaped before propagating outcome");
        assert!(owned, "transfer failure must retain actual child ownership");
        assert_eq!(
            observed,
            Some((1, 0)),
            "one actual transfer and no protocol/resource sends"
        );
        assert!(
            matches!(error, Some(Error::Io(error)) if error.to_string() == "injected resource seal transfer failure")
        );
        assert_resource_renames_released(&rename_paths);
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn windows_native_cwd_launch_seals_parent_and_ancestor_replacement() {
        for attempt in ["normal", "parent", "ancestor"] {
            let temp = tempfile::tempdir().unwrap();
            let outer = temp.path().join("outer");
            let parent = outer.join("cwd");
            std::fs::create_dir_all(&parent).unwrap();
            std::fs::write(parent.join("cwd-data"), b"cwd-original\n").unwrap();
            let image = parent.join("engine.exe");
            let command_processor = std::env::var_os("COMSPEC")
                .expect("Windows must provide its native command processor");
            std::fs::copy(command_processor, &image).unwrap();
            let mut authority =
                PathAuthority::open(temp.path().join("registry.json"), vec![]).unwrap();
            let engine = authority
                .register_engine_file(&image, "Native cwd probe")
                .unwrap();
            let executable = authority
                .engine_executable(&engine, PathOperation::EngineExecute)
                .unwrap();
            let source = if attempt == "ancestor" {
                &outer
            } else {
                &parent
            };
            let moved = temp.path().join("moved");
            if attempt != "normal" {
                let result = std::fs::rename(source, &moved);
                assert!(
                    result.is_err(),
                    "held native cwd must seal {attempt} replacement: {result:?}"
                );
                assert!(!moved.exists());
                assert_eq!(
                    std::fs::read(parent.join("cwd-data")).unwrap(),
                    b"cwd-original\n"
                );
            }
            // Exercise the actual CreateProcess boundary after the attempted substitution.
            assert_native_cwd_probe(executable, "type cwd-data").await;
            std::fs::rename(source, &moved)
                .expect("confirmed reaping must release the no-delete cwd and image handles");
        }
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn apple_native_cwd_launch_uses_original_object_after_movement() {
        use std::os::unix::fs::PermissionsExt;

        for replacement in [None, Some(false), Some(true)] {
            let temp = tempfile::tempdir().unwrap();
            let parent = temp.path().join("cwd");
            std::fs::create_dir(&parent).unwrap();
            std::fs::write(parent.join("cwd-data"), b"cwd-original\n").unwrap();
            let image = parent.join("engine");
            let bytes = std::fs::read("/bin/sh").unwrap();
            let mode = std::fs::metadata("/bin/sh").unwrap().permissions().mode() & 0o7777;
            crate::infra::test_executable::publish_test_executable(&image, bytes, mode).unwrap();
            let mut authority =
                PathAuthority::open(temp.path().join("registry.json"), vec![]).unwrap();
            let engine = authority
                .register_engine_file(&image, "Native cwd probe")
                .unwrap();
            let mut executable = authority
                .engine_executable(&engine, PathOperation::EngineExecute)
                .unwrap();
            let root =
                crate::infra::path_authority::EngineLaunchRoot::for_test(temp.path()).unwrap();
            executable.set_test_launch_root(root.clone());
            let key = EngineKey::new("cwd-probe".into(), "engine".into()).unwrap();
            pin_engine_launch(&mut executable, &key, "engine", &|| false).unwrap();
            if let Some(replace) = replacement {
                std::fs::rename(&parent, temp.path().join("moved-cwd")).unwrap();
                if replace {
                    std::fs::create_dir(&parent).unwrap();
                    std::fs::write(parent.join("cwd-data"), b"cwd-replacement\n").unwrap();
                }
            }
            assert_native_cwd_probe(executable, "/bin/cat cwd-data").await;
            assert_eq!(root.reclaim().removed, 1);
        }
    }

    type RecordedWrites = Arc<Mutex<Vec<String>>>;
    type RecordedWriteCompletions = Arc<Mutex<Vec<(String, tokio::time::Instant)>>>;
    type DeadlineFakeIoParts = (
        FakeIo,
        RecordedWrites,
        RecordedWriteCompletions,
        Arc<AtomicUsize>,
    );
    type FakeActor = (EngineActor, RecordedWrites);
    type FakeActorWithTermination = (FakeActor, Arc<AtomicUsize>);

    fn deadline_test_io(
        write_delays: &[(&str, Duration)],
        responses: &[(Duration, Option<&str>)],
        endless_line: Option<&str>,
        read_interval: Duration,
    ) -> DeadlineFakeIoParts {
        let writes = Arc::new(Mutex::new(Vec::new()));
        let write_completions = Arc::new(Mutex::new(Vec::new()));
        let terminate_calls = Arc::new(AtomicUsize::new(0));
        let mut io = FakeIo::new(writes.clone(), std::iter::empty());
        io.write_completions = write_completions.clone();
        io.write_delays = write_delays
            .iter()
            .map(|(command, delay)| ((*command).into(), *delay))
            .collect();
        io.lines = responses
            .iter()
            .map(|(delay, line)| (*delay, line.map(str::to_owned)))
            .collect();
        io.endless_line = endless_line.map(str::to_owned);
        io.read_interval = read_interval;
        io.pending_when_empty = true;
        io.terminate_calls = terminate_calls.clone();
        (io, writes, write_completions, terminate_calls)
    }

    fn write_completion_at(
        write_completions: &RecordedWriteCompletions,
        command: &str,
    ) -> tokio::time::Instant {
        write_completions
            .try_lock()
            .expect("test write completion lock must be available")
            .iter()
            .find_map(|(written, at)| (written == command).then_some(*at))
            .expect("the command write must have completed")
    }

    pub(super) enum FakeWait {
        Ready,
        Pending,
        Failed(&'static str),
    }

    pub(super) struct FakeChildControl {
        waits: VecDeque<FakeWait>,
        quit_pending: bool,
        quit_error: Option<&'static str>,
        kill_error: bool,
        kill_calls: Arc<AtomicUsize>,
        dropped: Arc<AtomicBool>,
    }

    impl Drop for FakeChildControl {
        fn drop(&mut self) {
            self.dropped.store(true, AtomicOrdering::SeqCst);
        }
    }

    #[async_trait]
    impl ChildCleanup for FakeChildControl {
        fn start_kill(&mut self) -> Result<(), Error> {
            self.kill_calls.fetch_add(1, AtomicOrdering::SeqCst);
            if self.kill_error {
                Err(io::Error::other("fake force-kill failed").into())
            } else {
                Ok(())
            }
        }

        async fn wait(&mut self) -> Result<(), Error> {
            match self.waits.pop_front().unwrap_or(FakeWait::Pending) {
                FakeWait::Ready => Ok(()),
                FakeWait::Pending => std::future::pending().await,
                FakeWait::Failed(cause) => Err(io::Error::other(cause).into()),
            }
        }
    }

    #[async_trait]
    impl ChildControl for FakeChildControl {
        async fn write_quit(&mut self) -> Result<(), Error> {
            if let Some(cause) = self.quit_error {
                return Err(io::Error::other(cause).into());
            }
            if self.quit_pending {
                std::future::pending().await
            } else {
                Ok(())
            }
        }
    }

    pub(super) fn child_control(
        waits: impl IntoIterator<Item = FakeWait>,
    ) -> (FakeChildControl, Arc<AtomicUsize>, Arc<AtomicBool>) {
        let kill_calls = Arc::new(AtomicUsize::new(0));
        let dropped = Arc::new(AtomicBool::new(false));
        (
            FakeChildControl {
                waits: waits.into_iter().collect(),
                quit_pending: false,
                quit_error: None,
                kill_error: false,
                kill_calls: kill_calls.clone(),
                dropped: dropped.clone(),
            },
            kill_calls,
            dropped,
        )
    }

    #[tokio::test]
    async fn teardown_success_after_reap_logs_native_causes() {
        let capture = crate::error::LogCaptureScope::start();
        let (mut child, _, _) = child_control([FakeWait::Ready]);
        child.kill_error = true;
        assert!(matches!(
            force_kill_and_reap(&mut child, Duration::from_secs(1)).await,
            ForceKillAndReap::Reaped
        ));
        assert!(capture.messages().iter().any(|line| line.contains("engine force-kill reported an error but child reaped: I/O failure: fake force-kill failed")));
        let (mut child, _, _) = child_control([FakeWait::Ready]);
        child.quit_error = Some("quit-write-private-cause");
        terminate_child(&mut child, Duration::from_secs(1), Duration::from_secs(1))
            .await
            .unwrap();
        assert!(capture.messages().iter().any(|line| line.contains(
            "engine quit write failed after child exited: I/O failure: quit-write-private-cause"
        )));
        let (mut child, _, _) = child_control([
            FakeWait::Failed("graceful-wait-private-cause"),
            FakeWait::Ready,
        ]);
        terminate_child(&mut child, Duration::from_secs(1), Duration::from_secs(1))
            .await
            .unwrap();
        assert!(capture.messages().iter().any(|line| line.contains("engine graceful shutdown failed but child reaped: I/O failure: graceful-wait-private-cause")));
    }

    #[test]
    fn pin_cleanup_logger_retains_both_native_causes() {
        let capture = crate::error::LogCaptureScope::start();
        let key = EngineKey::new("pin-log-tab".into(), "pin-log-engine".into()).unwrap();
        log_pin_cleanup_failure(
            &key,
            "binary",
            &io::Error::other("pin-primary-private-cause").into(),
            &io::Error::other("pin-cleanup-private-cause").into(),
        );
        assert!(capture.messages().iter().any(|line| line
            .contains("key=pin-log-tab:pin-log-engine")
            && line.contains("engine_id=binary")
            && line.contains("pin-primary-private-cause")
            && line.contains("pin-cleanup-private-cause")));
    }

    #[tokio::test]
    async fn terminate_child_skips_force_kill_when_graceful_wait_succeeds() {
        let (mut child, kill_calls, dropped) = child_control([FakeWait::Ready]);
        terminate_child(
            &mut child,
            Duration::from_millis(5),
            Duration::from_millis(5),
        )
        .await
        .unwrap();
        assert_eq!(kill_calls.load(AtomicOrdering::SeqCst), 0);
        assert!(!dropped.load(AtomicOrdering::SeqCst));
        drop(child);
        assert!(dropped.load(AtomicOrdering::SeqCst));
    }

    #[tokio::test]
    async fn retained_cleanup_deterministic_owner_retries_original_child() {
        let (child, calls, dropped) =
            child_control([FakeWait::Pending, FakeWait::Pending, FakeWait::Ready]);
        let slots = Arc::new(Semaphore::new(1));
        let owner = ChildOwner::default();
        {
            let mut state = owner.state.lock().unwrap();
            state.control = Some(Box::new(child));
            state.slot = Some(slots.clone().try_acquire_owned().unwrap());
        }
        let first = owner
            .terminate(Duration::from_millis(1), Duration::from_millis(1), true)
            .await;
        assert!(first.is_err(), "first bounded reap must fail");
        assert!(owner.unresolved(), "unconfirmed child must remain owned");
        assert!(
            !dropped.load(Ordering::SeqCst),
            "original child handle must survive failure"
        );
        assert_eq!(
            slots.available_permits(),
            0,
            "failed owner retains capacity"
        );
        owner
            .terminate(Duration::ZERO, Duration::from_millis(1), false)
            .await
            .unwrap();
        assert!(!owner.unresolved(), "confirmed reap releases ownership");
        assert!(dropped.load(Ordering::SeqCst));
        assert_eq!(slots.available_permits(), 1);
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn retained_cleanup_pre_spawn_abandonment_releases_reserved_slot() {
        let slots = Arc::new(Semaphore::new(1));
        let owner = ChildOwner::default();
        owner.state.lock().unwrap().slot = Some(slots.clone().try_acquire_owned().unwrap());
        assert_eq!(slots.available_permits(), 0);
        owner
            .terminate(Duration::ZERO, Duration::from_millis(1), false)
            .await
            .unwrap();
        assert_eq!(
            slots.available_permits(),
            1,
            "pre-spawn terminal cleanup releases its reserved slot while the owner remains alive"
        );
        assert!(!owner.unresolved());
    }

    #[tokio::test]
    async fn retained_cleanup_supervisor_callers_bind_before_lifecycle_wait() {
        type TerminationWaiter<'a> =
            std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), Error>> + 'a>>;

        for (held, cancelled, caller) in [false, true].into_iter().flat_map(|held| {
            [None, Some("first"), Some("second")]
                .into_iter()
                .flat_map(move |cancelled| {
                    [
                        "exact",
                        "release",
                        "stop",
                        "unscoped",
                        "kill",
                        "drain",
                        "replacement",
                    ]
                    .map(|caller| (held, cancelled, caller))
                })
        }) {
            let supervisor = Arc::new(EngineSupervisor::default());
            let key = EngineKey::new(
                format!("bound-attempt-{held}-{cancelled:?}-{caller}"),
                "engine".into(),
            )
            .unwrap();
            let expected = Arc::new(Error::Conflict("original-overlapping-reap-failure".into()));
            let gate = TerminationReplyGate::new();
            let mut io = FakeIo::new(Arc::default(), []);
            io.termination_error = Some(expected.clone());
            io.termination_gate = Some(gate.clone());
            let calls = io.terminate_calls.clone();
            let mut actor = EngineActor::new(Box::new(io), EngineDeadlines::default());
            let owner = Arc::new(ChildOwner::default());
            let (child, _, dropped) = child_control([FakeWait::Ready]);
            owner.state.lock().unwrap().control = Some(Box::new(child));
            actor.cleanup = Some(owner);
            let current = supervisor.replace(key.clone(), actor).await.unwrap();
            let lifecycle = supervisor.lifecycle_lease(&key);
            let transition = if held {
                Some(lifecycle.lock().await)
            } else {
                None
            };
            let mut first: TerminationWaiter<'_> =
                Box::pin(supervisor.terminate_exact(&key, current.generation));
            assert!(futures_util::poll!(first.as_mut()).is_pending());
            wait_for_pending_termination(&gate).await;
            assert!(
                lifecycle.try_lock().is_err(),
                "A's teardown or its caller holds the lifecycle lock"
            );
            let snapshot = if matches!(caller, "kill" | "drain") {
                let snapshot = TerminationReplyGate::new();
                TEARDOWN_SNAPSHOT_GATES.arm((key.clone(), current.generation), snapshot.clone());
                Some(snapshot)
            } else {
                None
            };
            let mut second: TerminationWaiter<'_> = match caller {
                "release" => Box::pin(supervisor.release_generation(&key, current.generation)),
                "stop" => Box::pin(async {
                    supervisor
                        .stop_search(&key, Some(current.generation))
                        .await
                        .map(|_| ())
                }),
                "unscoped" => {
                    Box::pin(async { supervisor.stop_search(&key, None).await.map(|_| ()) })
                }
                "kill" => Box::pin(supervisor.kill_engine(&key)),
                "drain" => Box::pin(supervisor.terminate_tab(&key.tab)),
                "replacement" => Box::pin(async {
                    let (actor, _) = EngineActor::recording_test_actor(&[]);
                    supervisor
                        .replace(key.clone(), (*actor).clone())
                        .await
                        .map(|_| ())
                }),
                _ => Box::pin(supervisor.terminate_exact(&key, current.generation)),
            };
            assert!(futures_util::poll!(second.as_mut()).is_pending());
            if let Some(snapshot) = &snapshot {
                assert!(
                    snapshot.parked.load(Ordering::SeqCst),
                    "second caller crossed its snapshot barrier"
                );
            }
            let pending = supervisor
                .pending_actors
                .get(&current.generation)
                .unwrap()
                .clone();
            let attempt = pending
                .termination
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .clone();
            let mut first = Some(first);
            let mut second = Some(second);
            match cancelled {
                Some("first") => drop(first.take()),
                Some("second") => drop(second.take()),
                _ => {}
            }
            gate.open();
            pending_test_wait(async {
                while attempt.result.get().is_none() {
                    tokio::task::yield_now().await;
                }
            })
            .await;
            if let Some(snapshot) = snapshot {
                snapshot.open();
            }
            assert!(
                !dropped.load(Ordering::SeqCst),
                "caller cancellation cannot reap or drop the retained child"
            );
            drop(transition);
            for waiter in [first, second].into_iter().flatten() {
                let error = waiter.await.unwrap_err();
                assert_same_termination_failure(&error, &expected);
            }
            assert!(
                !dropped.load(Ordering::SeqCst),
                "attached callers must not start a retry"
            );
            supervisor
                .terminate_exact(&key, current.generation)
                .await
                .unwrap();
            assert!(dropped.load(Ordering::SeqCst));
            assert_eq!(calls.load(Ordering::SeqCst), 1);
            let (successor, _) = EngineActor::recording_test_actor(&[]);
            let successor = supervisor
                .replace(key.clone(), (*successor).clone())
                .await
                .unwrap();
            supervisor
                .terminate_exact(&key, current.generation)
                .await
                .unwrap();
            assert_eq!(
                supervisor.get_exact(&key).unwrap().generation,
                successor.generation
            );
            supervisor
                .terminate_exact(&key, successor.generation)
                .await
                .unwrap();
        }
    }

    #[tokio::test]
    async fn retained_cleanup_pending_attempts_survive_cancellation_and_recovery() {
        let supervisor = Arc::new(EngineSupervisor::default());
        let key = EngineKey::new("retained-attempt".into(), "engine".into()).unwrap();
        let expected = Arc::new(Error::RootFailure {
            error: Box::new(Error::from(io::Error::other(
                "/private/original-attempt-diagnostic",
            ))),
            reason: crate::error::RootFailure::Unusable,
        });
        let gate = TerminationReplyGate::new();
        let mut io = FakeIo::new(Arc::default(), []);
        io.termination_error = Some(expected.clone());
        io.termination_gate = Some(gate.clone());
        let calls = io.terminate_calls.clone();
        let mut actor = EngineActor::new(Box::new(io), EngineDeadlines::default());
        let owner = Arc::new(ChildOwner::default());
        let (child, _, dropped) = child_control([FakeWait::Ready]);
        owner.state.lock().unwrap().control = Some(Box::new(child));
        actor.cleanup = Some(owner.clone());
        let admission = supervisor
            .admit(key.clone(), key.engine.clone(), path_ref("retained"), false)
            .await
            .unwrap();
        let pending = supervisor.track_pending_actor(key.clone(), Arc::new(actor), &admission);
        let first = pending.start_termination(supervisor.pending_actors.clone());
        wait_for_pending_termination(&gate).await;
        let attached = pending.start_termination(supervisor.pending_actors.clone());
        assert!(
            Arc::ptr_eq(&first, &attached),
            "concurrent owners share one attempt"
        );
        let waiter = tokio::spawn({
            let pending = pending.clone();
            let entries = supervisor.pending_actors.clone();
            async move { pending.terminate(entries).await }
        });
        tokio::task::yield_now().await;
        waiter.abort();
        let _ = waiter.await;
        gate.open();
        pending_test_wait(async {
            while first.result.get().is_none() {
                tokio::task::yield_now().await;
            }
        })
        .await;
        assert!(
            supervisor.pending_actors.contains_key(&pending.generation),
            "failed attempt stays discoverable"
        );
        let failure = first.result.get().unwrap().as_ref().unwrap_err().clone();
        assert_same_termination_failure(&failure, &expected);
        supervisor.terminate_tab(&key.tab).await.unwrap();
        assert!(supervisor.pending_actors.is_empty());
        assert!(dropped.load(Ordering::SeqCst));
        assert_same_termination_failure(
            first.result.get().unwrap().as_ref().unwrap_err(),
            &failure,
        );
        assert_same_termination_failure(
            attached.result.get().unwrap().as_ref().unwrap_err(),
            &failure,
        );
        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "retry must not rerun protocol actor"
        );
    }

    #[tokio::test]
    async fn retained_cleanup_actor_join_panic_survives_recovered_reap() {
        let capture = crate::error::LogCaptureScope::start();
        const MARKER: &str = "/private/retained-actor-panic-marker";
        let supervisor = EngineSupervisor::default();
        let key = EngineKey::new("retained-panic".into(), "engine".into()).unwrap();
        let actor = EngineActor::recoverable_cleanup_test_actor();
        let old = actor.task.lock().await.take().unwrap();
        old.abort();
        let _ = old.await;
        *actor.task.lock().await = Some(tokio::spawn(async { panic!("{MARKER}") }));
        let admission = supervisor
            .admit(key.clone(), key.engine.clone(), path_ref("panic"), false)
            .await
            .unwrap();
        let pending = supervisor.track_pending_actor(key.clone(), actor, &admission);
        let first = pending
            .terminate(supervisor.pending_actors.clone())
            .await
            .unwrap_err();
        assert!(!serde_json::to_string(&first).unwrap().contains(MARKER));
        let retry = pending
            .terminate(supervisor.pending_actors.clone())
            .await
            .unwrap_err();
        assert_eq!(
            retry.category(),
            crate::error::ErrorCategory::Conflict,
            "successful child retry cannot erase actor join failure"
        );
        assert!(!serde_json::to_string(&retry).unwrap().contains(MARKER));
        assert!(capture.records().iter().any(|record| {
            record.level == log::Level::Error
                && record.message.contains("engine actor task failed")
                && record.message.contains("retained-panic:engine generation=")
                && record.message.contains(MARKER)
        }));
    }

    #[tokio::test(start_paused = true)]
    async fn retained_cleanup_repeated_failed_shutdown_is_bounded_and_generation_exact() {
        let supervisor = EngineSupervisor::default();
        let key = EngineKey::new("retained-shutdown".into(), "engine".into()).unwrap();
        let actor = EngineActor::recoverable_cleanup_test_actor();
        let owner = actor.cleanup.as_ref().unwrap();
        let (child, kill_calls, dropped) = child_control([FakeWait::Pending]);
        owner.state.lock().unwrap().control = Some(Box::new(child));
        let current = supervisor
            .replace_handle(
                key.clone(),
                actor.clone(),
                key.engine.clone(),
                path_ref("shared"),
            )
            .await
            .unwrap();
        assert!(supervisor
            .terminate_exact(&key, current.generation)
            .await
            .is_err());
        let newer = supervisor
            .replace_handle(
                key.clone(),
                EngineActor::recording_test_actor(&[]).0,
                key.engine.clone(),
                path_ref("shared"),
            )
            .await
            .unwrap();
        assert_ne!(newer.generation, current.generation);
        for expected_kill_calls in 1..=2 {
            let result = timeout(Duration::from_secs(3), supervisor.terminate_tab(&key.tab))
                .await
                .expect("one drain visits a failed generation only once");
            assert!(
                result.is_err(),
                "unconfirmed reap cannot report successful shutdown"
            );
            assert_eq!(kill_calls.load(Ordering::SeqCst), expected_kill_calls);
            assert!(supervisor.pending_actors.contains_key(&current.generation));
            assert!(!dropped.load(Ordering::SeqCst));
        }
        assert!(supervisor.get_exact(&key).is_none());
        let (recovered_child, _, recovered_dropped) = child_control([FakeWait::Ready]);
        owner.state.lock().unwrap().control = Some(Box::new(recovered_child));
        supervisor.terminate_all().await.unwrap();
        assert!(supervisor.pending_actors.is_empty());
        assert!(!owner.unresolved());
        assert!(recovered_dropped.load(Ordering::SeqCst));
    }

    #[cfg(unix)]
    fn stdin_waiting_executable(directory: &tempfile::TempDir) -> EngineExecutable {
        let executable = std::fs::canonicalize("/bin/cat").unwrap();
        EngineExecutable::test_fixture(
            std::fs::File::open(executable).unwrap(),
            directory.path().to_owned(),
            Vec::new(),
        )
    }

    #[cfg(unix)]
    fn copy_closed_cat_fixture(directory: &tempfile::TempDir) -> std::path::PathBuf {
        let executable = std::fs::canonicalize("/bin/cat").unwrap();
        let destination = directory.path().join("stdin-waiting-cat");
        let bytes = std::fs::read(executable).unwrap();
        crate::infra::test_executable::publish_test_executable(&destination, bytes, 0o755).unwrap();
        destination
    }

    #[cfg(unix)]
    fn stdin_waiting_observer_executable(directory: &tempfile::TempDir) -> EngineExecutable {
        #[cfg(target_os = "macos")]
        {
            EngineExecutable::test_fixture(
                std::fs::File::open(copy_closed_cat_fixture(directory)).unwrap(),
                directory.path().to_owned(),
                Vec::new(),
            )
        }
        #[cfg(not(target_os = "macos"))]
        {
            stdin_waiting_executable(directory)
        }
    }

    #[cfg(unix)]
    #[test]
    fn copy_closed_cat_fixtures_are_private_executable_copies() {
        use std::os::unix::fs::PermissionsExt;

        let directory_a = tempfile::tempdir().unwrap();
        let directory_b = tempfile::tempdir().unwrap();
        let path_a = copy_closed_cat_fixture(&directory_a);
        let path_b = copy_closed_cat_fixture(&directory_b);
        let canonical_cat = std::fs::canonicalize("/bin/cat").unwrap();
        let canonical_length = std::fs::metadata(&canonical_cat).unwrap().len();

        assert_ne!(path_a, path_b);
        for path in [&path_a, &path_b] {
            assert!(path.is_file());
            assert_ne!(path, &canonical_cat);
            let metadata = std::fs::metadata(path).unwrap();
            assert_eq!(metadata.len(), canonical_length);
            assert_eq!(metadata.permissions().mode() & 0o111, 0o111);
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn stdin_waiting_observer_executables_have_distinct_command_targets() {
        let directory_a = tempfile::tempdir().unwrap();
        let directory_b = tempfile::tempdir().unwrap();
        let executable_a = stdin_waiting_observer_executable(&directory_a);
        let executable_b = stdin_waiting_observer_executable(&directory_b);
        let target_a = executable_a.command_target();
        let target_b = executable_b.command_target();
        let canonical_cat = std::fs::canonicalize("/bin/cat").unwrap();

        assert_ne!(target_a, target_b);
        for target in [target_a, target_b] {
            assert_ne!(target, canonical_cat.as_path());
            assert_eq!(target.file_name().unwrap(), "stdin-waiting-cat");
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn retained_cleanup_real_child_capacity_and_retry_before_spawn() {
        let supervisor = EngineSupervisor {
            child_slots: Arc::new(Semaphore::new(1)),
            ..EngineSupervisor::default()
        };
        let directory = tempfile::tempdir().unwrap();
        let key = EngineKey::new("retained-real".into(), "same-engine".into()).unwrap();
        let admission = supervisor
            .admit(
                key.clone(),
                key.engine.clone(),
                path_ref("same-path"),
                false,
            )
            .await
            .unwrap();
        set_terminate_failure(Some(TerminateFailure::QuitKillReap));
        let pending = supervisor
            .spawn_pending(&key, stdin_waiting_executable(&directory), &admission)
            .await
            .unwrap();
        let owner = pending.cleanup.as_ref().unwrap().clone();
        let current = supervisor
            .publish_admitted(key.clone(), pending.clone(), admission)
            .await
            .unwrap();
        let original = owner
            .state
            .lock()
            .unwrap()
            .control
            .as_ref()
            .unwrap()
            .as_ref() as *const dyn ChildControl;
        let first = supervisor
            .terminate_exact(&key, current.generation)
            .await
            .unwrap_err();
        assert_eq!(
            first.category(),
            crate::error::ErrorCategory::OperationAndCleanup
        );
        let retained = supervisor
            .pending_actors
            .get(&current.generation)
            .unwrap()
            .clone();
        assert!(
            Arc::ptr_eq(retained.cleanup.as_ref().unwrap(), &owner),
            "published handoff retains the original cleanup authority and slot"
        );
        {
            let state = owner.state.lock().unwrap();
            assert!(
                std::ptr::eq(state.control.as_ref().unwrap().as_ref(), original),
                "original child authority is retained"
            );
            assert!(
                state.executable.is_some(),
                "executable leases survive failed reap"
            );
            assert!(state.slot.is_some(), "failed generation keeps its slot");
        }
        let other = EngineKey::new("retained-real-other".into(), "same-engine".into()).unwrap();
        let admission2 = supervisor
            .admit(
                other.clone(),
                other.engine.clone(),
                path_ref("same-path"),
                false,
            )
            .await
            .unwrap();
        let executable = stdin_waiting_executable(&directory);
        let refused = supervisor
            .spawn_pending(&other, executable, &admission2)
            .await;
        assert!(
            matches!(refused, Err(Error::ResourceLimit(_))),
            "capacity refusal precedes child creation"
        );
        assert!(
            supervisor.spawn_attempts.load(Ordering::SeqCst) == 1,
            "full ownership cannot cross production spawn boundary"
        );
        pending.actor.get().unwrap().clear_cleanup_test_failure();
        supervisor
            .terminate_exact(&key, pending.generation)
            .await
            .unwrap();
        assert_eq!(supervisor.child_slots.available_permits(), 1);
        assert!(supervisor.pending_actors.is_empty());
        let executable = stdin_waiting_executable(&directory);
        let next = supervisor
            .spawn_pending(&other, executable, &admission2)
            .await
            .unwrap();
        next.terminate(supervisor.pending_actors.clone())
            .await
            .unwrap();
        assert_eq!(supervisor.spawn_attempts.load(Ordering::SeqCst), 2);
        let cancelled = supervisor
            .admit(
                key.clone(),
                key.engine.clone(),
                path_ref("same-path"),
                false,
            )
            .await
            .unwrap();
        supervisor.cancel_admission(&key, &cancelled.admission);
        assert!(matches!(
            supervisor
                .spawn_pending(&key, stdin_waiting_executable(&directory), &cancelled)
                .await,
            Err(Error::Cancellation)
        ));
        assert_eq!(
            supervisor.child_slots.available_permits(),
            1,
            "pre-spawn abandonment returns capacity"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn retained_cleanup_partial_io_survives_failed_reap() {
        for fault in [SpawnIoFailure::NoStdin, SpawnIoFailure::NoStdout] {
            let directory = tempfile::tempdir().unwrap();
            assert_partial_io_retains_child_until_reaped(&directory, fault).await;
        }
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn retained_cleanup_fixture_reaches_partial_io_with_original_script_open_for_writing() {
        for fault in [SpawnIoFailure::NoStdin, SpawnIoFailure::NoStdout] {
            let directory = tempfile::tempdir().unwrap();
            let writer =
                hold_original_waiting_script_open_for_writing(&directory, "retained-child.sh");
            assert_partial_io_retains_child_until_reaped(&directory, fault).await;
            drop(writer);
        }
    }

    #[cfg(target_os = "linux")]
    fn hold_original_waiting_script_open_for_writing(
        directory: &tempfile::TempDir,
        filename: &str,
    ) -> std::fs::File {
        use std::{io::Write, os::unix::fs::PermissionsExt};

        let mut writer = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(directory.path().join(filename))
            .unwrap();
        writer
            .write_all(b"#!/bin/sh\nwhile IFS= read -r line; do :; done\n")
            .unwrap();
        writer
            .set_permissions(std::fs::Permissions::from_mode(0o700))
            .unwrap();
        writer
    }

    #[cfg(unix)]
    async fn assert_partial_io_retains_child_until_reaped(
        directory: &tempfile::TempDir,
        fault: SpawnIoFailure,
    ) {
        let supervisor = EngineSupervisor::default();
        let key = EngineKey::new(format!("partial-{fault:?}"), "engine".into()).unwrap();
        let admission = supervisor
            .admit(key.clone(), key.engine.clone(), path_ref("partial"), false)
            .await
            .unwrap();
        set_spawn_io_failure(Some(fault));
        set_terminate_failure(Some(TerminateFailure::ReapError));
        let result = supervisor
            .spawn_pending(&key, stdin_waiting_executable(directory), &admission)
            .await;
        assert!(
            matches!(&result, Err(Error::OperationAndCleanup { .. })),
            "partial IO reports failed cleanup, got {:?}",
            result.as_ref().err().map(Error::diagnostic)
        );
        let pending = supervisor
            .pending_actors
            .get(&admission.generation())
            .unwrap()
            .clone();
        let owner = pending.cleanup.as_ref().unwrap();
        {
            let mut state = owner.state.lock().unwrap();
            assert!(state.executable.is_some());
            assert!(state.slot.is_some());
            state.control.as_mut().unwrap().clear_failure();
        }
        supervisor.terminate_tab(&key.tab).await.unwrap();
        assert!(!owner.unresolved());
        assert!(supervisor.pending_actors.is_empty());
        assert_eq!(
            supervisor.child_slots.available_permits(),
            MAX_OWNED_CHILDREN
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn retained_cleanup_capacity_concurrent_admissions_refuse_before_spawn() {
        let supervisor = EngineSupervisor {
            child_slots: Arc::new(Semaphore::new(1)),
            ..EngineSupervisor::default()
        };
        let directory = tempfile::tempdir().unwrap();
        let key_a = EngineKey::new("capacity-a".into(), "same-name".into()).unwrap();
        let key_b = EngineKey::new("capacity-b".into(), "same-name".into()).unwrap();
        let admission_a = supervisor
            .admit(
                key_a.clone(),
                key_a.engine.clone(),
                path_ref("same-path"),
                false,
            )
            .await
            .unwrap();
        let admission_b = supervisor
            .admit(
                key_b.clone(),
                key_b.engine.clone(),
                path_ref("same-path"),
                false,
            )
            .await
            .unwrap();
        let a = stdin_waiting_executable(&directory);
        let b = stdin_waiting_executable(&directory);
        let (a, b) = tokio::join!(
            supervisor.spawn_pending(&key_a, a, &admission_a),
            supervisor.spawn_pending(&key_b, b, &admission_b)
        );
        let mut rejections = Vec::new();
        for result in [a, b] {
            match result {
                Ok(pending) => pending
                    .terminate(supervisor.pending_actors.clone())
                    .await
                    .unwrap(),
                Err(error) => rejections.push(error),
            }
        }
        assert_eq!(
            supervisor.spawn_attempts.load(Ordering::SeqCst),
            1,
            "only the reserved generation may spawn"
        );
        assert!(
            matches!(rejections.as_slice(), [Error::ResourceLimit(_)]),
            "overflow rejects before production child creation"
        );
        assert_eq!(supervisor.child_slots.available_permits(), 1);
    }

    #[tokio::test]
    async fn terminate_child_force_kills_then_reaps_after_graceful_timeout() {
        let (mut child, kill_calls, _) = child_control([FakeWait::Pending, FakeWait::Ready]);
        terminate_child(
            &mut child,
            Duration::from_millis(5),
            Duration::from_millis(5),
        )
        .await
        .unwrap();
        assert_eq!(kill_calls.load(AtomicOrdering::SeqCst), 1);
    }

    #[tokio::test]
    async fn terminate_child_retains_child_after_force_kill_reap_timeout() {
        let (mut child, _, dropped) = child_control([FakeWait::Pending, FakeWait::Pending]);
        let result = terminate_child(
            &mut child,
            Duration::from_millis(5),
            Duration::from_millis(5),
        )
        .await;
        assert!(matches!(result, Err(Error::EngineTimeout(_))));
        assert!(!dropped.load(AtomicOrdering::SeqCst));
    }

    #[tokio::test]
    async fn force_kill_reporter_timeout_retains_kill_cause_and_child() {
        let (mut child, _, dropped) = child_control([FakeWait::Pending, FakeWait::Pending]);
        child.kill_error = true;
        let result = terminate_child(
            &mut child,
            Duration::from_millis(5),
            Duration::from_millis(5),
        )
        .await;
        match result {
            Err(Error::OperationAndCleanup { primary, cleanup }) => {
                assert!(primary.contains("waiting for engine exit"));
                assert!(cleanup.contains("fake force-kill failed"));
            }
            other => panic!("expected force-kill cleanup failure, got {other:?}"),
        }
        assert!(!dropped.load(AtomicOrdering::SeqCst));
    }

    #[test]
    fn force_kill_reporter_preserves_io_diagnostics_with_kill_failure() {
        const PRIMARY: &str = "force-kill-primary-io-cause";
        const KILL: &str = "force-kill-operation-io-cause";
        const REAP: &str = "force-kill-reap-io-cause";
        let primary = Error::from(io::Error::other(PRIMARY));
        let result = map_force_kill_and_reap(
            &primary,
            ForceKillAndReap::ReapFailed {
                kill_error: Some(Error::from(io::Error::other(KILL))),
                reap_error: Error::from(io::Error::other(REAP)),
            },
            ReapTimeoutPolicy::OperationAndCleanup,
        );

        match result {
            Err(Error::OperationAndCleanup { primary, cleanup }) => {
                assert!(primary.contains(PRIMARY));
                assert!(cleanup.contains(KILL));
                assert!(cleanup.contains(REAP));
                assert!(!primary.contains(KILL));
                assert!(!primary.contains(REAP));
            }
            other => panic!("expected force-kill and reap failure, got {other:?}"),
        }
    }

    #[test]
    fn force_kill_reporter_preserves_io_diagnostics_without_kill_failure() {
        const PRIMARY: &str = "force-reap-primary-io-cause";
        const REAP: &str = "force-reap-only-io-cause";
        let primary = Error::from(io::Error::other(PRIMARY));
        let result = map_force_kill_and_reap(
            &primary,
            ForceKillAndReap::ReapFailed {
                kill_error: None,
                reap_error: Error::from(io::Error::other(REAP)),
            },
            ReapTimeoutPolicy::OperationAndCleanup,
        );

        match result {
            Err(Error::OperationAndCleanup { primary, cleanup }) => {
                assert!(primary.contains(PRIMARY));
                assert!(cleanup.contains(REAP));
                assert!(!primary.contains(REAP));
            }
            other => panic!("expected final reap failure, got {other:?}"),
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn pin_failure_preserves_primary_and_cleanup_diagnostics() {
        const PRIMARY: &str = "pin-failure-primary-io-cause";
        const CLEANUP: &str = "pin-failure-cleanup-io-cause";
        let capture = crate::error::LogCaptureScope::start();
        let key = EngineKey::new("pin-failure-test".into(), "pin-failure-test".into()).unwrap();
        let error = PinFailure::OperationAndCleanup {
            primary: Error::from(io::Error::other(PRIMARY)),
            cleanup: Error::from(io::Error::other(CLEANUP)),
        }
        .into_error(&key, "pin-failure-test");
        assert!(capture
            .messages()
            .iter()
            .any(|message| message.contains(PRIMARY) && message.contains(CLEANUP)));

        match error {
            Error::OperationAndCleanup { primary, cleanup } => {
                assert!(primary.contains(PRIMARY));
                assert!(cleanup.contains(CLEANUP));
                assert!(!primary.contains(CLEANUP));
                assert!(!cleanup.contains(PRIMARY));
            }
            other => panic!("expected pin cleanup failure, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn terminate_child_bounds_a_stuck_quit_write() {
        let (mut child, _, _) = child_control([FakeWait::Ready]);
        child.quit_pending = true;
        let _ = tokio::time::timeout(
            Duration::from_millis(30),
            terminate_child(
                &mut child,
                Duration::from_millis(5),
                Duration::from_millis(5),
            ),
        )
        .await
        .expect("quit write must be bounded");
    }

    fn actor(lines: &[&str]) -> FakeActor {
        actor_with(lines, false, None).0
    }

    fn fake_actor_with_config(
        lines: &[&str],
        fail_write: bool,
        fail_stop: bool,
        read_delay: Option<Duration>,
        read_observation: Option<ReadObservation>,
        terminate_delay: Option<Duration>,
        deadlines: EngineDeadlines,
    ) -> FakeActorWithTermination {
        let writes = Arc::new(Mutex::new(Vec::new()));
        let terminate_calls = Arc::new(AtomicUsize::new(0));
        let mut io = FakeIo::new(
            writes.clone(),
            lines.iter().map(|line| Some((*line).into())),
        );
        io.terminate_calls = terminate_calls.clone();
        io.fail_write = fail_write;
        io.fail_stop = fail_stop;
        io.read_delay = read_delay;
        io.read_observation = read_observation;
        io.terminate_delay = terminate_delay;
        (
            (EngineActor::new(Box::new(io), deadlines), writes),
            terminate_calls,
        )
    }

    fn actor_with(
        lines: &[&str],
        fail_write: bool,
        read_delay: Option<Duration>,
    ) -> FakeActorWithTermination {
        let deadlines = EngineDeadlines {
            search: Duration::from_millis(20),
            stop: Duration::from_millis(20),
            ..EngineDeadlines::default()
        };
        fake_actor_with_config(lines, fail_write, false, read_delay, None, None, deadlines)
    }

    fn delayed_search_actor(
        lines: &[&str],
        read_delay: Duration,
        read_started: Option<Arc<AtomicBool>>,
    ) -> FakeActor {
        delayed_search_actor_with_attempts(lines, read_delay, read_started, None)
    }

    fn delayed_search_actor_with_attempts(
        lines: &[&str],
        read_delay: Duration,
        read_started: Option<Arc<AtomicBool>>,
        read_attempts: Option<Arc<AtomicUsize>>,
    ) -> FakeActor {
        let deadlines = EngineDeadlines {
            search: Duration::from_millis(500),
            stop: Duration::from_millis(500),
            ..EngineDeadlines::default()
        };
        fake_actor_with_config(
            lines,
            false,
            false,
            Some(read_delay),
            read_observation(read_started, read_attempts),
            None,
            deadlines,
        )
        .0
    }

    fn read_observation(
        started: Option<Arc<AtomicBool>>,
        attempts: Option<Arc<AtomicUsize>>,
    ) -> Option<ReadObservation> {
        if started.is_none() && attempts.is_none() {
            None
        } else {
            Some(ReadObservation { started, attempts })
        }
    }

    fn actor_with_terminate_delay(delay: Duration) -> FakeActorWithTermination {
        fake_actor_with_config(
            &[],
            false,
            false,
            None,
            None,
            Some(delay),
            EngineDeadlines::default(),
        )
    }

    fn actor_with_observed_terminate_delay(
        delay: Duration,
        terminate_started: Arc<AtomicBool>,
    ) -> FakeActorWithTermination {
        let writes = Arc::new(Mutex::new(Vec::new()));
        let terminate_calls = Arc::new(AtomicUsize::new(0));
        let mut io = FakeIo::new(writes.clone(), std::iter::empty());
        io.terminate_calls = terminate_calls.clone();
        io.terminate_delay = Some(delay);
        io.terminate_started = Some(terminate_started);
        (
            (
                EngineActor::new(Box::new(io), EngineDeadlines::default()),
                writes,
            ),
            terminate_calls,
        )
    }

    fn actor_with_stop_failure(lines: &[&str]) -> FakeActorWithTermination {
        fake_actor_with_config(
            lines,
            false,
            true,
            None,
            None,
            None,
            EngineDeadlines::default(),
        )
    }

    fn actor_with_stop_failure_and_pending_read(
        read_delay: Duration,
        read_started: Option<Arc<AtomicBool>>,
    ) -> FakeActorWithTermination {
        fake_actor_with_config(
            &["bestmove e2e4"],
            false,
            true,
            Some(read_delay),
            read_observation(read_started, None),
            None,
            EngineDeadlines {
                search: Duration::from_millis(500),
                stop: Duration::from_millis(500),
                ..EngineDeadlines::default()
            },
        )
    }

    fn path_ref(id: &str) -> PathRef {
        PathRef { id: id.into() }
    }

    fn registration_cleanup_messages(key: &EngineKey, generation: u64) -> Vec<String> {
        let identity = format!("for {}:{} generation={generation} ", key.tab, key.engine);
        match CLEANUP_FAILURE_LOG.lock() {
            Ok(errors) => errors
                .iter()
                .filter(|message| message.contains(&identity))
                .cloned()
                .collect(),
            Err(poisoned) => poisoned
                .into_inner()
                .iter()
                .filter(|message| message.contains(&identity))
                .cloned()
                .collect(),
        }
    }

    fn registration_guard_drop_completed(key: &EngineKey, generation: u64) -> Option<bool> {
        match REGISTRATION_GUARD_DROPS.lock() {
            Ok(drops) => drops
                .iter()
                .rev()
                .find(|(dropped_key, dropped_generation, _)| {
                    dropped_key == key && *dropped_generation == generation
                })
                .map(|(_, _, completed)| *completed),
            Err(poisoned) => poisoned
                .into_inner()
                .iter()
                .rev()
                .find(|(dropped_key, dropped_generation, _)| {
                    dropped_key == key && *dropped_generation == generation
                })
                .map(|(_, _, completed)| *completed),
        }
    }

    async fn wait_for_flag(flag: &AtomicBool, reason: &str) {
        tokio::time::timeout(Duration::from_secs(2), async {
            while !flag.load(Ordering::SeqCst) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("timed out waiting for {reason}"));
    }

    async fn wait_for_registration_removed(
        supervisor: &EngineSupervisor,
        key: &EngineKey,
        generation: u64,
    ) {
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if !supervisor.owns_generation(key, generation) {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("exact engine generation must be removed");
    }

    async fn wait_for_registration_cleanup_cause(
        key: &EngineKey,
        generation: u64,
        cause: &str,
    ) -> Vec<String> {
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let messages = registration_cleanup_messages(key, generation);
                if messages.iter().any(|message| message.contains(cause)) {
                    break messages;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("exact engine cleanup failure must be logged")
    }

    struct TerminateErrorIo;

    struct GatedTerminateIo {
        gate: Arc<TerminationReplyGate>,
        calls: Arc<AtomicUsize>,
        failure: Option<&'static str>,
    }

    #[async_trait]
    impl UciIo for GatedTerminateIo {
        async fn write_line(&mut self, _: &str) -> Result<(), Error> {
            Ok(())
        }

        async fn read_line(&mut self) -> Result<Option<String>, Error> {
            std::future::pending().await
        }

        async fn terminate(&mut self, _: Duration, _: Duration) -> Result<(), Error> {
            self.gate.park().await;
            self.calls.fetch_add(1, Ordering::SeqCst);
            match self.failure {
                Some(sentinel) => Err(io::Error::other(sentinel).into()),
                None => Ok(()),
            }
        }
    }

    pub(super) fn gated_pending_actor(
        failure: Option<&'static str>,
    ) -> (
        Arc<EngineActor>,
        Arc<TerminationReplyGate>,
        Arc<AtomicUsize>,
    ) {
        let gate = TerminationReplyGate::new();
        let calls = Arc::new(AtomicUsize::new(0));
        let actor = Arc::new(EngineActor::new(
            Box::new(GatedTerminateIo {
                gate: gate.clone(),
                calls: calls.clone(),
                failure,
            }),
            EngineDeadlines::default(),
        ));
        (actor, gate, calls)
    }

    async fn pending_test_wait<T>(future: impl std::future::Future<Output = T>) -> T {
        timeout(Duration::from_secs(2), future)
            .await
            .expect("pending actor operation must finish")
    }

    async fn wait_for_pending_actor(supervisor: &EngineSupervisor, generation: u64) {
        pending_test_wait(async {
            while !supervisor.pending_actors.contains_key(&generation) {
                tokio::task::yield_now().await;
            }
        })
        .await;
    }

    async fn wait_for_pending_termination(gate: &TerminationReplyGate) {
        pending_test_wait(async {
            while !gate.parked.load(Ordering::SeqCst) {
                tokio::task::yield_now().await;
            }
        })
        .await;
    }

    async fn kill_engine_prepared(supervisor: &EngineSupervisor, key: &EngineKey) -> String {
        supervisor
            .prepare_engine_search(key.clone(), key.engine.clone(), path_ref("kill-image"))
            .await
            .unwrap()
    }

    async fn kill_engine_consume(
        supervisor: &EngineSupervisor,
        key: &EngineKey,
        generation: &str,
    ) -> Result<AdmissionLease, Error> {
        supervisor
            .consume_engine_search(
                key.clone(),
                key.engine.clone(),
                path_ref("kill-image"),
                generation,
            )
            .await
    }

    // Models the fresh launch after its cancellation check, holding the production lifecycle
    // lease across the untracked-child window and using the production publication path.
    fn kill_engine_paused_launch(
        supervisor: Arc<EngineSupervisor>,
        key: EngineKey,
        admission: AdmissionLease,
        actor: Arc<EngineActor>,
        pause: Arc<TerminationReplyGate>,
    ) -> tokio::task::JoinHandle<Result<(), Error>> {
        tokio::spawn(async move {
            let lifecycle = supervisor.lifecycle_lease(&key);
            let _transition = lifecycle.lock().await;
            assert!(admission.cancel_error().is_none());
            pause.park().await;
            let pending = supervisor.track_pending_actor(key.clone(), actor, &admission);
            let mut guard =
                PendingActorGuard::new(pending.clone(), supervisor.pending_actors.clone());
            let published = supervisor
                .publish_admitted_locked(key, pending, admission, None)
                .await;
            guard.disarm();
            published?
                .actor
                .start_search(&GoMode::Infinite)
                .await
                .map(|_| ())
        })
    }

    #[tokio::test]
    async fn kill_engine_prepared_is_cancelled_and_later_and_other_keys_admit() {
        let supervisor = EngineSupervisor::default();
        let key = EngineKey::new("kill-v1".into(), "engine".into()).unwrap();
        let other = EngineKey::new("kill-v1".into(), "other".into()).unwrap();
        let generation = kill_engine_prepared(&supervisor, &key).await;
        let other_generation = kill_engine_prepared(&supervisor, &other).await;
        supervisor.kill_engine(&key).await.unwrap();
        assert!(supervisor.get_exact(&key).is_none());
        assert!(matches!(
            kill_engine_consume(&supervisor, &key, &generation).await,
            Err(Error::Cancellation)
        ));
        let admission = supervisor.admissions.get(&key).unwrap();
        assert!(!admission.prepared);
        assert_eq!(admission.generation.to_string(), generation);
        drop(admission);
        assert!(kill_engine_consume(&supervisor, &other, &other_generation)
            .await
            .is_ok());
        let next = kill_engine_prepared(&supervisor, &key).await;
        assert_ne!(generation, next);
        assert!(matches!(
            kill_engine_consume(&supervisor, &key, &generation).await,
            Err(Error::Conflict(_))
        ));
        assert!(kill_engine_consume(&supervisor, &key, &next).await.is_ok());
        supervisor.kill_engine(&key).await.unwrap();
    }

    #[tokio::test]
    async fn kill_engine_clears_prepared_capacity() {
        let supervisor = EngineSupervisor::default();
        let key = EngineKey::new("kill-capacity".into(), "engine".into()).unwrap();
        kill_engine_prepared(&supervisor, &key).await;
        supervisor.kill_engine(&key).await.unwrap();
        for index in 0..MAX_PENDING_ENGINE_SEARCHES {
            let other = EngineKey::new("kill-capacity".into(), format!("engine-{index}")).unwrap();
            kill_engine_prepared(&supervisor, &other).await;
        }
        let extra = EngineKey::new("kill-capacity".into(), "extra".into()).unwrap();
        assert!(matches!(
            supervisor
                .prepare_engine_search(extra, "extra".into(), path_ref("kill-image"))
                .await,
            Err(Error::ResourceLimit(_))
        ));
    }

    #[tokio::test]
    async fn kill_engine_other_key_actors_are_untouched() {
        let supervisor = EngineSupervisor::default();
        let key = EngineKey::new("kill-isolation".into(), "engine".into()).unwrap();
        let other = EngineKey::new("kill-isolation-other-tab".into(), "engine".into()).unwrap();
        let (actor, _) = actor(&[]);
        let published = supervisor.replace(other.clone(), actor).await.unwrap();
        let generation = kill_engine_prepared(&supervisor, &other).await;
        let admission = kill_engine_consume(&supervisor, &other, &generation)
            .await
            .unwrap();
        let (actor, gate, calls) = gated_pending_actor(None);
        let pending = supervisor.track_pending_actor(other.clone(), actor, &admission);
        kill_engine_prepared(&supervisor, &key).await;
        pending_test_wait(supervisor.kill_engine(&key))
            .await
            .unwrap();
        assert_eq!(
            supervisor.get_exact(&other).unwrap().generation,
            published.generation
        );
        assert!(!published.cancelled.load(Ordering::SeqCst));
        assert!(admission.cancel_error().is_none());
        assert!(supervisor.pending_actors.contains_key(&pending.generation));
        assert!(!gate.parked.load(Ordering::SeqCst));
        gate.open();
        pending
            .terminate(supervisor.pending_actors.clone())
            .await
            .unwrap();
        supervisor
            .terminate_exact(&other, published.generation)
            .await
            .unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn kill_engine_consumed_untracked_launch_cannot_publish_or_go() {
        let supervisor = Arc::new(EngineSupervisor::default());
        let key = EngineKey::new("kill-v2".into(), "engine".into()).unwrap();
        let generation = kill_engine_prepared(&supervisor, &key).await;
        let admission = kill_engine_consume(&supervisor, &key, &generation)
            .await
            .unwrap();
        let ((actor, writes), calls) = actor_with(&[], false, None);
        let pause = TerminationReplyGate::new();
        let launch = kill_engine_paused_launch(
            supervisor.clone(),
            key.clone(),
            admission,
            Arc::new(actor),
            pause.clone(),
        );
        wait_for_pending_termination(&pause).await;
        pending_test_wait(supervisor.kill_engine(&key))
            .await
            .unwrap();
        assert!(!launch.is_finished());
        assert!(supervisor.pending_actors.is_empty());
        pause.open();
        assert!(matches!(
            pending_test_wait(launch).await.unwrap(),
            Err(Error::Cancellation)
        ));
        assert!(supervisor.get_exact(&key).is_none());
        assert!(supervisor.pending_actors.is_empty());
        assert!(!writes
            .lock()
            .await
            .iter()
            .any(|line| line.starts_with("go")));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn kill_engine_published_and_new_prepared_reservation_are_stopped() {
        let supervisor = EngineSupervisor::default();
        let key = EngineKey::new("kill-v3".into(), "engine".into()).unwrap();
        let ((actor, _), calls) = actor_with(&[], false, None);
        let published = supervisor.replace(key.clone(), actor).await.unwrap();
        let generation = kill_engine_prepared(&supervisor, &key).await;
        assert_ne!(published.generation.to_string(), generation);
        supervisor.kill_engine(&key).await.unwrap();
        assert!(supervisor.get_exact(&key).is_none());
        assert!(published.cancelled.load(Ordering::SeqCst));
        assert!(matches!(
            kill_engine_consume(&supervisor, &key, &generation).await,
            Err(Error::Cancellation)
        ));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn kill_engine_waits_for_tracked_pending_and_shares_failure() {
        for failure in [None, Some("kill-v4-reap-failure")] {
            let supervisor = EngineSupervisor::default();
            let key = EngineKey::new(format!("kill-v4-{failure:?}"), "engine".into()).unwrap();
            let generation = kill_engine_prepared(&supervisor, &key).await;
            let admission = kill_engine_consume(&supervisor, &key, &generation)
                .await
                .unwrap();
            let (actor, gate, calls) = gated_pending_actor(failure);
            let pending = supervisor.track_pending_actor(key.clone(), actor, &admission);
            // Another owner has already begun the reap before Kill crosses the barrier.
            pending.start_termination(supervisor.pending_actors.clone());
            wait_for_pending_termination(&gate).await;
            let kill = supervisor.kill_engine(&key);
            tokio::pin!(kill);
            assert!(futures_util::poll!(&mut kill).is_pending());
            assert!(supervisor
                .pending_actors
                .contains_key(&admission.generation()));
            gate.open();
            let result = pending_test_wait(kill).await;
            if let Some(sentinel) = failure {
                let error = result.unwrap_err();
                assert!(matches!(error, Error::Shared(_)));
                assert!(error.diagnostic().contains(sentinel));
            } else {
                result.unwrap();
            }
            assert!(supervisor.pending_actors.is_empty());
            assert_eq!(calls.load(Ordering::SeqCst), 1);
        }
    }

    #[tokio::test]
    async fn kill_engine_combines_published_and_pending_failures() {
        let supervisor = EngineSupervisor::default();
        let key = EngineKey::new("kill-v5".into(), "engine".into()).unwrap();
        let (actor, published_gate, published_calls) =
            gated_pending_actor(Some("kill-published-failure"));
        let published = supervisor
            .replace_handle(key.clone(), actor, "engine".into(), path_ref("kill-image"))
            .await
            .unwrap();
        let generation = kill_engine_prepared(&supervisor, &key).await;
        let admission = kill_engine_consume(&supervisor, &key, &generation)
            .await
            .unwrap();
        let (actor, pending_gate, pending_calls) =
            gated_pending_actor(Some("kill-pending-failure"));
        supervisor.track_pending_actor(key.clone(), actor, &admission);
        let kill = supervisor.kill_engine(&key);
        tokio::pin!(kill);
        assert!(futures_util::poll!(&mut kill).is_pending());
        wait_for_pending_termination(&published_gate).await;
        wait_for_pending_termination(&pending_gate).await;
        let exact = supervisor.terminate_exact(&key, published.generation);
        tokio::pin!(exact);
        assert!(futures_util::poll!(&mut exact).is_pending());
        published_gate.open();
        let exact_error = pending_test_wait(exact).await.unwrap_err();
        assert!(matches!(exact_error, Error::Shared(_)));
        assert!(exact_error.diagnostic().contains("kill-published-failure"));
        // Exact termination has finished while the other generation is still blocked.
        assert!(futures_util::poll!(&mut kill).is_pending());
        pending_gate.open();
        let error = pending_test_wait(kill).await.unwrap_err();
        assert_eq!(
            error.to_string(),
            "Operation failed; temporary cleanup also failed"
        );
        match error {
            Error::OperationAndCleanup { primary, cleanup } => {
                assert!(primary.contains("kill-published-failure"));
                assert!(cleanup.contains("kill-pending-failure"));
            }
            other => panic!("expected combined failures, got {other:?}"),
        }
        assert_eq!(published_calls.load(Ordering::SeqCst), 1);
        assert_eq!(pending_calls.load(Ordering::SeqCst), 1);
        assert!(supervisor.pending_actors.is_empty());
    }

    #[tokio::test]
    async fn kill_engine_exact_termination_does_not_reap_other_generation() {
        let supervisor = EngineSupervisor::default();
        let key = EngineKey::new("kill-exact-scope".into(), "engine".into()).unwrap();
        let (actor, published_gate, published_calls) = gated_pending_actor(None);
        let published = supervisor
            .replace_handle(key.clone(), actor, "engine".into(), path_ref("kill-image"))
            .await
            .unwrap();
        let generation = kill_engine_prepared(&supervisor, &key).await;
        let admission = kill_engine_consume(&supervisor, &key, &generation)
            .await
            .unwrap();
        let (actor, pending_gate, pending_calls) = gated_pending_actor(None);
        let pending = supervisor.track_pending_actor(key.clone(), actor, &admission);
        let exact = supervisor.terminate_exact(&key, published.generation);
        tokio::pin!(exact);
        assert!(futures_util::poll!(&mut exact).is_pending());
        wait_for_pending_termination(&published_gate).await;
        assert!(!pending_gate.parked.load(Ordering::SeqCst));
        published_gate.open();
        pending_test_wait(exact).await.unwrap();
        assert!(supervisor.pending_actors.contains_key(&pending.generation));
        assert!(admission.cancel_error().is_none());
        assert_eq!(pending_calls.load(Ordering::SeqCst), 0);
        pending_gate.open();
        supervisor.kill_engine(&key).await.unwrap();
        assert_eq!(published_calls.load(Ordering::SeqCst), 1);
        assert_eq!(pending_calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn kill_engine_published_reap_and_drains_ignore_paused_launch_lock() {
        for all in [false, true] {
            let supervisor = Arc::new(EngineSupervisor::default());
            let key = EngineKey::new(format!("kill-v8-{all}"), "engine".into()).unwrap();
            let (actor, gate, calls) = gated_pending_actor(None);
            let published = supervisor
                .replace_handle(key.clone(), actor, "engine".into(), path_ref("old-image"))
                .await
                .unwrap();
            let search =
                SupervisedSearch::new(published.generation, Arc::new(AtomicBool::new(false)));
            published.bind_search(search.clone());
            let generation = kill_engine_prepared(&supervisor, &key).await;
            let admission = kill_engine_consume(&supervisor, &key, &generation)
                .await
                .unwrap();
            let ((actor, writes), late_calls) = actor_with(&[], false, None);
            let pause = TerminationReplyGate::new();
            let launch = kill_engine_paused_launch(
                supervisor.clone(),
                key.clone(),
                admission,
                Arc::new(actor),
                pause.clone(),
            );
            wait_for_pending_termination(&pause).await;
            let kill = supervisor.kill_engine(&key);
            tokio::pin!(kill);
            assert!(futures_util::poll!(&mut kill).is_pending());
            wait_for_pending_termination(&gate).await;
            assert!(supervisor.get_exact(&key).is_none());
            assert!(supervisor
                .pending_actors
                .contains_key(&published.generation));
            assert!(!published
                .try_publish(|| -> Result<(), Error> { panic!("cancelled actor emitted") })
                .unwrap());
            assert!(search.cancelled.load(Ordering::SeqCst));
            assert!(!search
                .try_publish(|| -> Result<(), Error> { panic!("cancelled search emitted") })
                .unwrap());
            let drain = async {
                if all {
                    supervisor.terminate_all().await
                } else {
                    supervisor.terminate_tab(&key.tab).await
                }
            };
            tokio::pin!(drain);
            assert!(futures_util::poll!(&mut drain).is_pending());
            assert!(futures_util::poll!(&mut kill).is_pending());
            gate.open();
            pending_test_wait(kill).await.unwrap();
            pending_test_wait(drain).await.unwrap();
            assert!(!launch.is_finished());
            assert!(supervisor.pending_actors.is_empty());
            assert_eq!(calls.load(Ordering::SeqCst), 1);
            pause.open();
            assert!(matches!(
                pending_test_wait(launch).await.unwrap(),
                Err(Error::Cancellation)
            ));
            assert!(supervisor.get_exact(&key).is_none());
            assert!(supervisor.pending_actors.is_empty());
            assert!(!writes
                .lock()
                .await
                .iter()
                .any(|line| line.starts_with("go")));
            assert_eq!(late_calls.load(Ordering::SeqCst), 1);
        }
    }

    #[tokio::test]
    async fn kill_engine_dropped_waiter_leaves_shared_reap_for_drain() {
        let supervisor = Arc::new(EngineSupervisor::default());
        let key = EngineKey::new("kill-drop".into(), "engine".into()).unwrap();
        let (actor, gate, calls) = gated_pending_actor(None);
        let published = supervisor
            .replace_handle(key.clone(), actor, "engine".into(), path_ref("kill-image"))
            .await
            .unwrap();
        let kill = tokio::spawn({
            let supervisor = supervisor.clone();
            let key = key.clone();
            async move { supervisor.kill_engine(&key).await }
        });
        wait_for_pending_termination(&gate).await;
        kill.abort();
        assert!(pending_test_wait(kill).await.unwrap_err().is_cancelled());
        assert!(supervisor
            .pending_actors
            .contains_key(&published.generation));
        let drain = supervisor.terminate_tab(&key.tab);
        tokio::pin!(drain);
        assert!(futures_util::poll!(&mut drain).is_pending());
        gate.open();
        pending_test_wait(drain).await.unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(supervisor.pending_actors.is_empty());
    }

    fn spawn_admitted_publisher(
        supervisor: Arc<EngineSupervisor>,
        key: EngineKey,
        actor: Arc<EngineActor>,
        admission: AdmissionLease,
    ) -> tokio::task::JoinHandle<Result<(), Error>> {
        tokio::spawn(async move {
            initialize_admitted_actor(supervisor, key, actor, admission, |_| async { Ok(()) })
                .await
                .map(|(_, mut guard, ())| guard.disarm())
        })
    }

    fn assert_pending_shutdown_log(key: &EngineKey, generation: u64) {
        let identity = format!("for {}:{} generation={generation} ", key.tab, key.engine);
        let logs = SHUTDOWN_FAILURE_LOGS.lock().unwrap();
        assert!(
            logs.iter()
                .any(|message| message.contains(&identity)
                    && message.contains("category=I/O failure"))
        );
    }

    #[tokio::test]
    async fn pending_v1_dropped_publisher_exit_awaits_reap() {
        let supervisor = Arc::new(EngineSupervisor::default());
        let key = EngineKey::new("pending-v1".into(), "engine".into()).unwrap();
        let admission = supervisor
            .admit(key.clone(), "owner".into(), path_ref("v1"), false)
            .await
            .unwrap();
        let generation = admission.generation();
        let lifecycle = supervisor.lifecycle_lease(&key);
        let transition = lifecycle.lock().await;
        let (actor, gate, calls) = gated_pending_actor(None);
        let publisher = spawn_admitted_publisher(supervisor.clone(), key.clone(), actor, admission);
        wait_for_pending_actor(&supervisor, generation).await;
        publisher.abort();
        assert!(pending_test_wait(publisher)
            .await
            .unwrap_err()
            .is_cancelled());
        wait_for_pending_termination(&gate).await;
        let drain = supervisor.terminate_all();
        tokio::pin!(drain);
        assert!(futures_util::poll!(&mut drain).is_pending());
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        gate.open();
        pending_test_wait(drain).await.unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(supervisor.pending_actors.is_empty());
        drop(transition);
        assert!(supervisor.get_exact(&key).is_none());
    }

    #[tokio::test]
    async fn pending_v2_live_publisher_exit_bypasses_lifecycle() {
        let supervisor = Arc::new(EngineSupervisor::default());
        let key = EngineKey::new("pending-v2".into(), "engine".into()).unwrap();
        let admission = supervisor
            .admit(key.clone(), "owner".into(), path_ref("v2"), false)
            .await
            .unwrap();
        let generation = admission.generation();
        let lifecycle = supervisor.lifecycle_lease(&key);
        let transition = lifecycle.lock().await;
        let (actor, gate, calls) = gated_pending_actor(None);
        let publisher = spawn_admitted_publisher(supervisor.clone(), key.clone(), actor, admission);
        wait_for_pending_actor(&supervisor, generation).await;
        let drain = supervisor.terminate_all();
        tokio::pin!(drain);
        assert!(futures_util::poll!(&mut drain).is_pending());
        wait_for_pending_termination(&gate).await;
        gate.open();
        pending_test_wait(drain).await.unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(!publisher.is_finished());
        assert!(supervisor.pending_actors.is_empty());
        drop(transition);
        assert!(matches!(
            pending_test_wait(publisher).await.unwrap(),
            Err(Error::Cancellation)
        ));
        assert!(supervisor.get_exact(&key).is_none());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn pending_v2b_exit_attaches_to_inline_rejection() {
        let supervisor = Arc::new(EngineSupervisor::default());
        let key = EngineKey::new("pending-v2b".into(), "engine".into()).unwrap();
        let admission = supervisor
            .admit(key.clone(), "owner".into(), path_ref("v2b"), false)
            .await
            .unwrap();
        admission.admission.cancelled.store(true, Ordering::SeqCst);
        let (actor, gate, calls) = gated_pending_actor(None);
        let publisher = spawn_admitted_publisher(supervisor.clone(), key.clone(), actor, admission);
        wait_for_pending_termination(&gate).await;
        let drain = supervisor.terminate_all();
        tokio::pin!(drain);
        assert!(futures_util::poll!(&mut drain).is_pending());
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        gate.open();
        pending_test_wait(drain).await.unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(matches!(
            pending_test_wait(publisher).await.unwrap(),
            Err(Error::Cancellation)
        ));
        assert!(supervisor.pending_actors.is_empty());
        assert!(supervisor.get_exact(&key).is_none());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "current_thread")]
    async fn fresh_interactive_dropped_publisher_exit_awaits_child_termination() {
        use std::{ffi::CString, io::Write, os::unix::ffi::OsStrExt, os::unix::fs::OpenOptionsExt};

        let directory = tempfile::tempdir().unwrap();
        let script = directory.path().join("pending-interactive-engine.sh");
        let spawned = directory.path().join("spawned");
        let quitting = directory.path().join("quitting");
        let terminated = directory.path().join("terminated");
        let release = directory.path().join("release");
        let fifo_path = CString::new(release.as_os_str().as_bytes()).unwrap();
        // The CString stays alive for this call; mkfifo does not retain its pointer.
        assert_eq!(unsafe { libc::mkfifo(fifo_path.as_ptr(), 0o600) }, 0);
        crate::infra::test_executable::publish_test_executable(
            &script,
            format!(
                "#!/bin/sh\n: > '{}'\nwhile IFS= read -r line; do\n  case \"$line\" in\n    quit) : > '{}'; read -r release < '{}'; : > '{}'; exit 0;;\n  esac\ndone\n",
                spawned.display(), quitting.display(), release.display(), terminated.display(),
            ), 0o700)
        .unwrap();
        let mut authority = PathAuthority::open_for_engine_test(directory.path()).unwrap();
        let engine = authority
            .register_engine_file(&script, "pending-interactive-engine")
            .unwrap();
        let authority = crate::infra::path_authority::SharedPathAuthority::installed(authority);
        let supervisor = Arc::new(EngineSupervisor::default());
        let key = EngineKey::new("pending-interactive".into(), "engine".into()).unwrap();
        let admission = supervisor
            .admit(key.clone(), key.engine.clone(), engine.id.clone(), false)
            .await
            .unwrap();
        let generation = admission.generation();
        // Admission has crossed registration; hold the next publication behind that barrier.
        let registration = supervisor.registration.lock().await;
        let publisher = tokio::spawn({
            let supervisor = supervisor.clone();
            let key = key.clone();
            async move {
                supervisor
                    .start_interactive_search(
                        key,
                        engine,
                        authority,
                        admission,
                        crate::chess::EngineOptions::default(),
                        &GoMode::Infinite,
                    )
                    .await
                    .map(|_| ())
            }
        });
        pending_test_wait(async {
            while !spawned.exists() {
                tokio::task::yield_now().await;
            }
        })
        .await;
        assert!(!publisher.is_finished());
        assert!(supervisor.get_exact(&key).is_none());
        publisher.abort();
        assert!(pending_test_wait(publisher)
            .await
            .unwrap_err()
            .is_cancelled());
        pending_test_wait(async {
            while !quitting.exists() {
                tokio::task::yield_now().await;
            }
        })
        .await;
        drop(registration);
        // The registration guard observes the same physical teardown. Both it
        // and the drain remain pending until this child exits.
        let drain = supervisor.terminate_all();
        tokio::pin!(drain);
        let first_poll = futures_util::poll!(&mut drain);
        assert!(!terminated.exists());
        // A nonblocking FIFO writer releases the child without blocking a Tokio worker.
        pending_test_wait(async {
            loop {
                match std::fs::OpenOptions::new()
                    .write(true)
                    .custom_flags(libc::O_NONBLOCK)
                    .open(&release)
                {
                    Ok(mut writer) => {
                        writer.write_all(b"release\n").unwrap();
                        break;
                    }
                    Err(error) if error.raw_os_error() == Some(libc::ENXIO) => {
                        tokio::task::yield_now().await;
                    }
                    Err(error) => panic!("failed to release child termination: {error}"),
                }
            }
        })
        .await;
        assert!(
            first_poll.is_pending(),
            "shutdown returned before the spawned child's termination completed"
        );
        pending_test_wait(drain).await.unwrap();
        assert!(terminated.exists());
        pending_test_wait(async {
            while !REGISTRATION_GUARD_DROPS.lock().unwrap().iter().any(
                |(dropped_key, dropped_generation, completed)| {
                    dropped_key == &key && *dropped_generation == generation && *completed
                },
            ) {
                tokio::task::yield_now().await;
            }
        })
        .await;
        assert!(supervisor.pending_actors.is_empty());
        assert!(supervisor.get_exact(&key).is_none());
    }

    #[derive(Clone, Copy, Debug)]
    enum PendingRetirement {
        Engine,
        Binary,
        Executables,
    }

    #[derive(Clone, Copy)]
    enum ScopedPendingDrain {
        Tab,
        Retirement(PendingRetirement),
    }

    #[derive(Clone, Copy, Debug)]
    enum PendingTerminationStarter {
        Drain,
        Drop,
        InlineRejection,
    }

    #[derive(Clone, Copy, Debug)]
    enum PendingPublicationOutcome {
        Publication,
        Rejection,
        Drop,
    }

    async fn assert_scoped_pending_drain(
        matching: (EngineKey, &str, PathRef),
        surviving: (EngineKey, &str, PathRef),
        operation: ScopedPendingDrain,
    ) {
        let supervisor = Arc::new(EngineSupervisor::default());
        let (a, owner_a, path_a) = matching;
        let (b, owner_b, path_b) = surviving;
        let admission_a = supervisor
            .admit(a.clone(), owner_a.into(), path_a.clone(), false)
            .await
            .unwrap();
        let admission_b = supervisor
            .admit(b.clone(), owner_b.into(), path_b.clone(), false)
            .await
            .unwrap();
        let generation_a = admission_a.generation();
        let generation_b = admission_b.generation();
        let lifecycle_a = supervisor.lifecycle_lease(&a);
        let lifecycle_b = supervisor.lifecycle_lease(&b);
        let transition_a = lifecycle_a.lock().await;
        let transition_b = lifecycle_b.lock().await;
        let (actor_a, gate_a, calls_a) = gated_pending_actor(None);
        let ((actor_b, _), calls_b) = actor_with(&[], false, None);
        let publisher_a =
            spawn_admitted_publisher(supervisor.clone(), a.clone(), actor_a, admission_a);
        let publisher_b = spawn_admitted_publisher(
            supervisor.clone(),
            b.clone(),
            Arc::new(actor_b),
            admission_b,
        );
        wait_for_pending_actor(&supervisor, generation_a).await;
        wait_for_pending_actor(&supervisor, generation_b).await;
        let drain = async {
            match operation {
                ScopedPendingDrain::Tab => supervisor.terminate_tab(&a.tab).await,
                ScopedPendingDrain::Retirement(PendingRetirement::Engine) => {
                    supervisor.retire_engine(owner_a.into()).await
                }
                ScopedPendingDrain::Retirement(PendingRetirement::Binary) => {
                    supervisor
                        .retire_engine_binary(owner_a.into(), path_a, path_b)
                        .await
                }
                ScopedPendingDrain::Retirement(PendingRetirement::Executables) => {
                    supervisor.retire_executables(vec![path_a]).await
                }
            }
        };
        tokio::pin!(drain);
        assert!(futures_util::poll!(&mut drain).is_pending());
        wait_for_pending_termination(&gate_a).await;
        gate_a.open();
        pending_test_wait(drain).await.unwrap();
        assert_eq!(calls_a.load(Ordering::SeqCst), 1);
        assert_eq!(calls_b.load(Ordering::SeqCst), 0);
        assert!(supervisor.pending_actors.contains_key(&generation_b));
        drop(transition_a);
        drop(transition_b);
        let rejected = pending_test_wait(publisher_a).await.unwrap();
        match operation {
            ScopedPendingDrain::Tab => assert!(matches!(rejected, Err(Error::Cancellation))),
            ScopedPendingDrain::Retirement(PendingRetirement::Engine) => {
                assert!(matches!(rejected, Err(Error::EngineRetired)))
            }
            ScopedPendingDrain::Retirement(_) => {
                assert!(matches!(rejected, Err(Error::Cancellation)))
            }
        }
        pending_test_wait(publisher_b).await.unwrap().unwrap();
        assert!(supervisor.get_exact(&a).is_none());
        assert!(supervisor.get_exact(&b).is_some());
        assert!(supervisor.pending_actors.is_empty());
        assert_eq!(calls_b.load(Ordering::SeqCst), 0);
        pending_test_wait(supervisor.terminate_all()).await.unwrap();
    }

    #[tokio::test]
    async fn pending_v3_tab_drain_leaves_other_publisher_live() {
        assert_scoped_pending_drain(
            (
                EngineKey::new("pending-v3-a".into(), "engine".into()).unwrap(),
                "owner",
                path_ref("shared"),
            ),
            (
                EngineKey::new("pending-v3-b".into(), "engine".into()).unwrap(),
                "owner",
                path_ref("shared"),
            ),
            ScopedPendingDrain::Tab,
        )
        .await;
    }

    #[tokio::test]
    async fn pending_v4_retirement_matches_admission_identity() {
        // Exercise all predicates routed through retire_matching, including owner-id matching.
        for retirement in [
            PendingRetirement::Engine,
            PendingRetirement::Binary,
            PendingRetirement::Executables,
        ] {
            assert_scoped_pending_drain(
                (
                    EngineKey::new(format!("pending-v4-{retirement:?}"), "key-e".into()).unwrap(),
                    "owner-e",
                    path_ref("retired-image"),
                ),
                (
                    EngineKey::new(format!("pending-v4-{retirement:?}"), "key-f".into()).unwrap(),
                    "owner-f",
                    path_ref("current-image"),
                ),
                ScopedPendingDrain::Retirement(retirement),
            )
            .await;
        }
    }

    #[tokio::test]
    async fn pending_v5_failure_is_shared_by_drain_drop_and_rejection() {
        const SENTINEL: &str = "pending-v5-termination-diagnostic-sentinel";
        for starter in [
            PendingTerminationStarter::Drain,
            PendingTerminationStarter::Drop,
            PendingTerminationStarter::InlineRejection,
        ] {
            let supervisor = Arc::new(EngineSupervisor::default());
            let key = EngineKey::new(format!("pending-v5-{starter:?}"), "engine".into()).unwrap();
            let admission = supervisor
                .admit(key.clone(), "owner".into(), path_ref("v5"), false)
                .await
                .unwrap();
            let generation = admission.generation();
            if matches!(starter, PendingTerminationStarter::InlineRejection) {
                admission.admission.cancelled.store(true, Ordering::SeqCst);
            }
            let lifecycle = supervisor.lifecycle_lease(&key);
            let transition = lifecycle.lock().await;
            let (actor, gate, calls) = gated_pending_actor(Some(SENTINEL));
            let publisher =
                spawn_admitted_publisher(supervisor.clone(), key.clone(), actor, admission);
            wait_for_pending_actor(&supervisor, generation).await;
            let entry = supervisor
                .pending_actors
                .get(&generation)
                .unwrap()
                .value()
                .clone();
            let publisher = if matches!(starter, PendingTerminationStarter::Drop) {
                publisher.abort();
                assert!(pending_test_wait(publisher)
                    .await
                    .unwrap_err()
                    .is_cancelled());
                None
            } else {
                Some(publisher)
            };
            if matches!(starter, PendingTerminationStarter::InlineRejection) {
                drop(transition);
            }
            if !matches!(starter, PendingTerminationStarter::Drain) {
                wait_for_pending_termination(&gate).await;
            }
            let drain = supervisor.terminate_all();
            tokio::pin!(drain);
            assert!(futures_util::poll!(&mut drain).is_pending());
            wait_for_pending_termination(&gate).await;
            // A second awaiting owner must receive the same failure, even after map removal.
            let attached = entry.terminate(supervisor.pending_actors.clone());
            tokio::pin!(attached);
            assert!(futures_util::poll!(&mut attached).is_pending());
            gate.open();
            let error = pending_test_wait(drain).await.unwrap_err();
            let attached_error = pending_test_wait(attached).await.unwrap_err();
            let original = Error::from(io::Error::other(SENTINEL));
            for error in [&error, &attached_error] {
                assert_eq!(error.category(), original.category());
                assert_eq!(error.to_string(), original.to_string());
                assert_eq!(error.diagnostic(), original.diagnostic());
                assert!(error.diagnostic().contains(SENTINEL));
            }
            assert_pending_shutdown_log(&key, generation);
            assert_eq!(calls.load(Ordering::SeqCst), 1);
            assert!(supervisor.pending_actors.is_empty());
            if matches!(starter, PendingTerminationStarter::Drain) {
                // The live publisher remains blocked; cancellation starts its guard cleanup.
                let publisher = publisher.unwrap();
                publisher.abort();
                assert!(pending_test_wait(publisher)
                    .await
                    .unwrap_err()
                    .is_cancelled());
            } else if let Some(publisher) = publisher {
                match pending_test_wait(publisher).await.unwrap().unwrap_err() {
                    Error::OperationAndCleanup { primary, cleanup } => {
                        assert_eq!(primary, "Cancellation");
                        assert_eq!(cleanup, original.diagnostic());
                    }
                    other => panic!("expected shared rejection cleanup, got {other:?}"),
                }
            }
            let logs = PENDING_ACTOR_CLEANUP_ERRORS.lock().unwrap();
            assert!(logs.iter().any(|message| message.contains(&format!(
                "{}:{} generation={generation}",
                key.tab, key.engine
            ))));
            assert_eq!(calls.load(Ordering::SeqCst), 1);
        }
    }

    #[tokio::test]
    async fn pending_v8_cancelled_inline_owner_preserves_failure_and_reap() {
        const SENTINEL: &str = "pending-v8-cancelled-owner-diagnostic-sentinel";
        let supervisor = Arc::new(EngineSupervisor::default());
        let key = EngineKey::new("pending-v8".into(), "engine".into()).unwrap();
        let admission = supervisor
            .admit(key.clone(), "owner".into(), path_ref("v8"), false)
            .await
            .unwrap();
        let generation = admission.generation();
        admission.admission.cancelled.store(true, Ordering::SeqCst);
        let (actor, gate, calls) = gated_pending_actor(Some(SENTINEL));
        let publisher = spawn_admitted_publisher(supervisor.clone(), key.clone(), actor, admission);
        wait_for_pending_termination(&gate).await;
        publisher.abort();
        assert!(pending_test_wait(publisher)
            .await
            .unwrap_err()
            .is_cancelled());
        let drain = supervisor.terminate_all();
        tokio::pin!(drain);
        // Poll through the barrier and pending scan while termination is still gated.
        assert!(futures_util::poll!(&mut drain).is_pending());
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        gate.open();
        let error = pending_test_wait(drain).await.unwrap_err();
        let original = Error::from(io::Error::other(SENTINEL));
        assert_eq!(error.category(), original.category());
        assert_eq!(error.to_string(), original.to_string());
        assert_eq!(error.diagnostic(), original.diagnostic());
        assert!(error.diagnostic().contains(SENTINEL));
        assert_pending_shutdown_log(&key, generation);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(supervisor.pending_actors.is_empty());
        assert!(supervisor.get_exact(&key).is_none());
    }

    #[tokio::test]
    async fn pending_v6_entries_leave_on_publication_rejection_and_drop() {
        for outcome in [
            PendingPublicationOutcome::Publication,
            PendingPublicationOutcome::Rejection,
            PendingPublicationOutcome::Drop,
        ] {
            let supervisor = Arc::new(EngineSupervisor::default());
            let key = EngineKey::new(format!("pending-v6-{outcome:?}"), "engine".into()).unwrap();
            let admission = supervisor
                .admit(key.clone(), "owner".into(), path_ref("v6"), false)
                .await
                .unwrap();
            let generation = admission.generation();
            if matches!(outcome, PendingPublicationOutcome::Rejection) {
                admission.admission.cancelled.store(true, Ordering::SeqCst);
            }
            let ((actor, _), calls) = actor_with(&[], false, None);
            if matches!(outcome, PendingPublicationOutcome::Drop) {
                let lifecycle = supervisor.lifecycle_lease(&key);
                let transition = lifecycle.lock().await;
                let publisher = spawn_admitted_publisher(
                    supervisor.clone(),
                    key.clone(),
                    Arc::new(actor),
                    admission,
                );
                wait_for_pending_actor(&supervisor, generation).await;
                publisher.abort();
                assert!(pending_test_wait(publisher)
                    .await
                    .unwrap_err()
                    .is_cancelled());
                pending_test_wait(async {
                    while supervisor.pending_actors.contains_key(&generation) {
                        tokio::task::yield_now().await;
                    }
                })
                .await;
                drop(transition);
            } else {
                let result = pending_test_wait(initialize_admitted_actor(
                    supervisor.clone(),
                    key.clone(),
                    Arc::new(actor),
                    admission,
                    |_| async { Ok(()) },
                ))
                .await;
                assert_eq!(
                    result.is_ok(),
                    matches!(outcome, PendingPublicationOutcome::Publication)
                );
                if let Ok((_, mut guard, ())) = result {
                    guard.disarm();
                }
            }
            assert!(supervisor.pending_actors.is_empty());
            assert_eq!(
                supervisor.get_exact(&key).is_some(),
                matches!(outcome, PendingPublicationOutcome::Publication)
            );
            assert_eq!(
                calls.load(Ordering::SeqCst),
                usize::from(!matches!(outcome, PendingPublicationOutcome::Publication))
            );
            pending_test_wait(supervisor.terminate_all()).await.unwrap();
            assert_eq!(calls.load(Ordering::SeqCst), 1);
        }
    }

    struct PendingTerminateErrorIo;

    struct ObservedTerminateErrorIo {
        error: String,
        started: Arc<AtomicBool>,
        delay: Option<Duration>,
        calls: Arc<AtomicUsize>,
        lines: VecDeque<Option<String>>,
        search_read_started: Option<Arc<AtomicBool>>,
    }

    fn observed_terminate_failure_actor(
        error: &str,
        started: Arc<AtomicBool>,
        delay: Option<Duration>,
        lines: &[&str],
        search_read_started: Option<Arc<AtomicBool>>,
    ) -> (Arc<EngineActor>, Arc<AtomicUsize>) {
        let calls = Arc::new(AtomicUsize::new(0));
        let io = ObservedTerminateErrorIo {
            error: error.into(),
            started,
            delay,
            calls: calls.clone(),
            lines: lines.iter().map(|line| Some((*line).into())).collect(),
            search_read_started,
        };
        (
            Arc::new(EngineActor::new(
                Box::new(io),
                EngineDeadlines {
                    search: Duration::from_secs(5),
                    ..EngineDeadlines::default()
                },
            )),
            calls,
        )
    }

    #[derive(Clone, Copy)]
    enum TypedTerminateFailure {
        Timeout,
        OperationAndCleanup,
    }

    struct TypedTerminateErrorIo {
        failure: TypedTerminateFailure,
        terminate_calls: Arc<AtomicUsize>,
    }

    struct ProtocolAndTerminationErrorIo {
        operation_error: String,
        termination_error: String,
    }

    #[async_trait]
    impl UciIo for PendingTerminateErrorIo {
        async fn write_line(&mut self, _: &str) -> Result<(), Error> {
            Ok(())
        }

        async fn read_line(&mut self) -> Result<Option<String>, Error> {
            std::future::pending().await
        }

        async fn terminate(&mut self, _: Duration, _: Duration) -> Result<(), Error> {
            Err(io::Error::other("fake cancelled terminate failed").into())
        }
    }

    #[async_trait]
    impl UciIo for ObservedTerminateErrorIo {
        async fn write_line(&mut self, _: &str) -> Result<(), Error> {
            Ok(())
        }

        async fn read_line(&mut self) -> Result<Option<String>, Error> {
            if let Some(line) = self.lines.pop_front() {
                return Ok(line);
            }
            if let Some(started) = &self.search_read_started {
                started.store(true, AtomicOrdering::SeqCst);
                return std::future::pending().await;
            }
            Ok(None)
        }

        async fn terminate(&mut self, _: Duration, _: Duration) -> Result<(), Error> {
            self.started.store(true, AtomicOrdering::SeqCst);
            if let Some(delay) = self.delay {
                tokio::time::sleep(delay).await;
            }
            self.calls.fetch_add(1, AtomicOrdering::SeqCst);
            Err(io::Error::other(self.error.clone()).into())
        }
    }

    #[async_trait]
    impl UciIo for TerminateErrorIo {
        async fn write_line(&mut self, _: &str) -> Result<(), Error> {
            Ok(())
        }

        async fn read_line(&mut self) -> Result<Option<String>, Error> {
            Ok(None)
        }

        async fn terminate(&mut self, _: Duration, _: Duration) -> Result<(), Error> {
            Err(io::Error::other("fake terminate failed").into())
        }
    }

    #[async_trait]
    impl UciIo for TypedTerminateErrorIo {
        async fn write_line(&mut self, _: &str) -> Result<(), Error> {
            Ok(())
        }

        async fn read_line(&mut self) -> Result<Option<String>, Error> {
            Ok(None)
        }

        async fn terminate(&mut self, _: Duration, _: Duration) -> Result<(), Error> {
            self.terminate_calls.fetch_add(1, AtomicOrdering::SeqCst);
            match self.failure {
                TypedTerminateFailure::Timeout => {
                    Err(Error::EngineTimeout("typed timeout sentinel".into()))
                }
                TypedTerminateFailure::OperationAndCleanup => Err(Error::OperationAndCleanup {
                    primary: "typed primary sentinel".into(),
                    cleanup: "typed cleanup sentinel".into(),
                }),
            }
        }
    }

    #[async_trait]
    impl UciIo for ProtocolAndTerminationErrorIo {
        async fn write_line(&mut self, _: &str) -> Result<(), Error> {
            Err(io::Error::other(self.operation_error.clone()).into())
        }

        async fn read_line(&mut self) -> Result<Option<String>, Error> {
            std::future::pending().await
        }

        async fn terminate(&mut self, _: Duration, _: Duration) -> Result<(), Error> {
            Err(io::Error::other(self.termination_error.clone()).into())
        }
    }

    #[tokio::test]
    async fn initialization_and_termination_failure_are_combined_and_unpublished() {
        let supervisor = Arc::new(EngineSupervisor::default());
        let key = EngineKey::new("engine-config".into(), "probe".into()).unwrap();
        let actor = Arc::new(EngineActor::new(
            Box::new(TerminateErrorIo),
            EngineDeadlines::default(),
        ));

        let result = initialize_registered_actor(
            supervisor.clone(),
            key.clone(),
            actor,
            "probe".into(),
            path_ref("probe-path"),
            |actor| async move { actor.init_uci().await },
        )
        .await
        .map(|(_, mut guard, ())| guard.disarm());

        match result {
            Err(error @ Error::EngineFailure { .. }) => {
                assert!(matches!(operation_cause(&error), Error::EngineDisconnected));
                assert!(error.diagnostic().contains("fake terminate failed"));
                assert!(error.engine_failure_snapshot().is_some());
                assert_eq!(
                    error.category(),
                    crate::error::ErrorCategory::OperationAndCleanup
                );
            }
            other => panic!(
                "expected initialization and cleanup failure, got {:?}",
                other.map(|_| ())
            ),
        }
        assert!(supervisor.get_exact(&key).is_none());
        assert!(supervisor.admissions.is_empty());
    }

    #[tokio::test]
    async fn cancelled_registration_logs_a_failed_reap() {
        let supervisor = Arc::new(EngineSupervisor::default());
        let key = EngineKey::new(
            "cancelled-registration-logs".into(),
            "cancelled-registration-logs".into(),
        )
        .unwrap();
        let actor = Arc::new(EngineActor::new(
            Box::new(PendingTerminateErrorIo),
            EngineDeadlines::default(),
        ));
        let initialization = tokio::spawn({
            let supervisor = supervisor.clone();
            let key = key.clone();
            async move {
                initialize_registered_actor(
                    supervisor,
                    key,
                    actor,
                    "cancelled-probe".into(),
                    path_ref("probe-path"),
                    |actor| async move { actor.init_uci().await },
                )
                .await
                .map(|(_, mut guard, ())| guard.disarm())
            }
        });
        while supervisor.get_exact(&key).is_none() {
            tokio::task::yield_now().await;
        }
        let generation = supervisor.get_exact(&key).unwrap().generation;
        assert!(registration_cleanup_messages(&key, generation).is_empty());

        initialization.abort();
        let _ = initialization.await;
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if registration_cleanup_messages(&key, generation)
                    .iter()
                    .any(|message| message.contains("fake cancelled terminate failed"))
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("Drop cleanup failure must be logged");
        wait_for_registration_removed(&supervisor, &key, generation).await;
    }

    #[tokio::test]
    async fn registered_initialization_hands_off_armed_generation_guard() {
        let supervisor = Arc::new(EngineSupervisor::default());
        let other_key = EngineKey::new("handoff".into(), "other".into()).unwrap();
        let ((other_actor, _), other_calls) = actor_with(&[], false, None);
        let other = supervisor
            .replace(other_key.clone(), other_actor)
            .await
            .unwrap();

        for disposition in ["drop", "disarm", "terminate"] {
            let key = EngineKey::new("handoff".into(), disposition.into()).unwrap();
            let ((actor, _), calls) = actor_with(&[], false, None);
            let (published, mut guard, value) = initialize_registered_actor(
                supervisor.clone(),
                key.clone(),
                Arc::new(actor),
                disposition.into(),
                path_ref("handoff-path"),
                |_| async { Ok(17) },
            )
            .await
            .unwrap();
            assert_eq!(value, 17);
            assert_eq!(
                supervisor.get_exact(&key).unwrap().generation,
                published.generation
            );
            match disposition {
                "drop" => {
                    drop(guard);
                    wait_for_registration_removed(&supervisor, &key, published.generation).await;
                }
                "disarm" => {
                    guard.disarm();
                    drop(guard);
                    tokio::task::yield_now().await;
                    assert_eq!(
                        supervisor.get_exact(&key).unwrap().generation,
                        published.generation
                    );
                    assert_eq!(calls.load(AtomicOrdering::SeqCst), 0);
                    supervisor
                        .terminate_exact(&key, published.generation)
                        .await
                        .unwrap();
                }
                "terminate" => guard.terminate_now().await.unwrap(),
                _ => unreachable!(),
            }
            assert!(supervisor.get_exact(&key).is_none());
            assert_eq!(calls.load(AtomicOrdering::SeqCst), 1);
            assert_eq!(supervisor.registered_keys_for_tab("handoff").len(), 1);
            assert_eq!(
                supervisor.get_exact(&other_key).unwrap().generation,
                other.generation
            );
            assert_eq!(other_calls.load(AtomicOrdering::SeqCst), 0);
        }
        supervisor
            .terminate_exact(&other_key, other.generation)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn terminate_now_reaps_exact_generation_once() {
        let supervisor = Arc::new(EngineSupervisor::default());
        let key = EngineKey::new(
            "terminate-now-success".into(),
            "terminate-now-success".into(),
        )
        .unwrap();
        let ((actor, _), terminate_calls) = actor_with(&[], false, None);
        let supervised = supervisor
            .replace(key.clone(), actor)
            .await
            .expect("register test actor");

        RegistrationGuard::new(supervisor.clone(), key.clone(), supervised.generation)
            .terminate_now()
            .await
            .expect("guard should terminate its exact generation");
        assert!(supervisor.get_exact(&key).is_none());
        supervisor
            .terminate_exact(&key, supervised.generation)
            .await
            .expect("a second exact termination is idempotent");
        assert_eq!(terminate_calls.load(AtomicOrdering::SeqCst), 1);
    }

    #[tokio::test]
    async fn terminate_now_returns_and_logs_its_own_failure() {
        const CAUSE: &str = "terminate-now-requester-failure-cause";
        let supervisor = Arc::new(EngineSupervisor::default());
        let key = EngineKey::new(
            "terminate-now-failure".into(),
            "terminate-now-failure".into(),
        )
        .unwrap();
        let started = Arc::new(AtomicBool::new(false));
        let (actor, calls) = observed_terminate_failure_actor(CAUSE, started, None, &[], None);
        let supervised = supervisor
            .replace_handle(
                key.clone(),
                actor,
                key.engine.clone(),
                path_ref("terminate-now-failure"),
            )
            .await
            .expect("register test actor");
        assert!(registration_cleanup_messages(&key, supervised.generation).is_empty());

        let error = RegistrationGuard::new(supervisor.clone(), key.clone(), supervised.generation)
            .terminate_now()
            .await
            .expect_err("fake actor termination must fail");
        assert!(matches!(error.without_shared(), Error::Io(_)));
        assert!(!supervisor.owns_generation(&key, supervised.generation));
        assert_eq!(calls.load(AtomicOrdering::SeqCst), 1);
        let messages = registration_cleanup_messages(&key, supervised.generation);
        assert_eq!(
            messages.len(),
            2,
            "actor and requester both report the failure"
        );
        assert!(messages.iter().all(|message| message.contains(CAUSE)));
    }

    #[tokio::test]
    async fn terminate_now_and_drop_never_terminate_a_newer_generation() {
        let supervisor = Arc::new(EngineSupervisor::default());
        let key = EngineKey::new(
            "terminate-now-stale-generation".into(),
            "terminate-now-stale-generation".into(),
        )
        .unwrap();
        let ((old_actor, _), _) = actor_with(&[], false, None);
        let old = supervisor
            .replace(key.clone(), old_actor)
            .await
            .expect("register old actor");
        let old_guard = RegistrationGuard::new(supervisor.clone(), key.clone(), old.generation);

        let ((current_actor, _), current_calls) = actor_with(&[], false, None);
        let current = supervisor
            .replace(key.clone(), current_actor)
            .await
            .expect("replace with current actor");
        assert!(current.generation > old.generation);
        old_guard
            .terminate_now()
            .await
            .expect("a stale guard is an idempotent no-op");
        assert_eq!(
            supervisor.get_exact(&key).map(|entry| entry.generation),
            Some(current.generation)
        );
        assert_eq!(current_calls.load(AtomicOrdering::SeqCst), 0);

        let dropped_guard =
            RegistrationGuard::new(supervisor.clone(), key.clone(), current.generation);
        let ((latest_actor, _), latest_calls) = actor_with(&[], false, None);
        let latest = supervisor
            .replace(key.clone(), latest_actor)
            .await
            .expect("publish a newer actor before dropping the stale guard");
        assert!(latest.generation > current.generation);
        assert_eq!(
            registration_guard_drop_completed(&key, current.generation),
            None
        );
        drop(dropped_guard);
        tokio::time::timeout(Duration::from_secs(2), async {
            while registration_guard_drop_completed(&key, current.generation) != Some(true) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("the stale guard's exact reaper must complete");
        assert_eq!(
            supervisor.get_exact(&key).map(|entry| entry.generation),
            Some(latest.generation)
        );
        assert_eq!(latest_calls.load(AtomicOrdering::SeqCst), 0);
    }

    #[tokio::test]
    async fn terminate_now_cancelled_during_cleanup_keeps_its_guard_armed() {
        let supervisor = Arc::new(EngineSupervisor::default());
        let key = EngineKey::new(
            "terminate-now-cancelled-cleanup".into(),
            "terminate-now-cancelled-cleanup".into(),
        )
        .unwrap();
        let started = Arc::new(AtomicBool::new(false));
        let ((actor, _), terminate_calls) =
            actor_with_observed_terminate_delay(Duration::from_millis(50), started.clone());
        let supervised = supervisor
            .replace(key.clone(), actor)
            .await
            .expect("register test actor");
        assert_eq!(
            registration_guard_drop_completed(&key, supervised.generation),
            None
        );

        let supervisor_for_task = supervisor.clone();
        let key_for_task = key.clone();
        let termination = tokio::spawn(async move {
            RegistrationGuard::new(supervisor_for_task, key_for_task, supervised.generation)
                .terminate_now()
                .await
        });
        wait_for_flag(&started, "termination to start").await;
        termination.abort();
        let _ = termination.await;
        wait_for_registration_removed(&supervisor, &key, supervised.generation).await;
        assert_eq!(terminate_calls.load(AtomicOrdering::SeqCst), 1);
        tokio::time::timeout(Duration::from_secs(2), async {
            while registration_guard_drop_completed(&key, supervised.generation) != Some(true) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("the armed guard's reaper must finish");
    }

    #[tokio::test]
    async fn terminate_now_logs_failure_after_requester_is_cancelled_before_reply() {
        const CAUSE: &str = "terminate-now-before-reply-failure-cause";
        let supervisor = Arc::new(EngineSupervisor::default());
        let key = EngineKey::new(
            "terminate-now-before-reply".into(),
            "terminate-now-before-reply".into(),
        )
        .unwrap();
        let started = Arc::new(AtomicBool::new(false));
        let (actor, _) = observed_terminate_failure_actor(
            CAUSE,
            started.clone(),
            Some(Duration::from_millis(40)),
            &[],
            None,
        );
        let supervised = supervisor
            .replace_handle(
                key.clone(),
                actor,
                key.engine.clone(),
                path_ref("before-reply"),
            )
            .await
            .expect("register test actor");
        assert!(registration_cleanup_messages(&key, supervised.generation).is_empty());

        let termination = tokio::spawn({
            let supervisor = supervisor.clone();
            let key = key.clone();
            async move {
                RegistrationGuard::new(supervisor, key, supervised.generation)
                    .terminate_now()
                    .await
            }
        });
        wait_for_flag(&started, "actor termination before its reply").await;
        termination.abort();
        let _ = termination.await;
        wait_for_registration_removed(&supervisor, &key, supervised.generation).await;
        let messages =
            wait_for_registration_cleanup_cause(&key, supervised.generation, CAUSE).await;
        assert!(messages.iter().all(|message| message.contains(CAUSE)));
    }

    #[tokio::test]
    async fn terminate_now_logs_failure_after_requester_is_cancelled_after_reply() {
        const CAUSE: &str = "terminate-now-after-reply-failure-cause";
        let supervisor = Arc::new(EngineSupervisor::default());
        let key = EngineKey::new(
            "terminate-now-after-reply".into(),
            "terminate-now-after-reply".into(),
        )
        .unwrap();
        let started = Arc::new(AtomicBool::new(false));
        let (actor, _) = observed_terminate_failure_actor(CAUSE, started, None, &[], None);
        let supervised = supervisor
            .replace_handle(
                key.clone(),
                actor,
                key.engine.clone(),
                path_ref("after-reply"),
            )
            .await
            .expect("register test actor");
        assert!(registration_cleanup_messages(&key, supervised.generation).is_empty());
        let identity = (key.clone(), supervised.generation);
        let gate = TerminationReplyGate::new();
        TERMINATION_REPLY_GATES.arm(identity.clone(), gate.clone());

        let termination = tokio::spawn({
            let supervisor = supervisor.clone();
            let key = key.clone();
            async move {
                RegistrationGuard::new(supervisor, key, supervised.generation)
                    .terminate_now()
                    .await
            }
        });
        tokio::time::timeout(Duration::from_secs(2), async {
            while !gate.parked.load(Ordering::SeqCst) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("termination must park after the actor reply");
        assert!(
            registration_cleanup_messages(&key, supervised.generation)
                .iter()
                .any(|message| message.contains(CAUSE)),
            "the actor must log its failure before delivering the reply"
        );

        termination.abort();
        let _ = termination.await;
        gate.open();
        TERMINATION_REPLY_GATES.clear(&identity);
        wait_for_registration_removed(&supervisor, &key, supervised.generation).await;
        assert!(registration_cleanup_messages(&key, supervised.generation)
            .iter()
            .any(|message| message.contains(CAUSE)));
    }

    #[tokio::test]
    async fn terminate_now_logs_control_failure_during_active_search() {
        const CAUSE: &str = "terminate-now-control-channel-failure-cause";
        let supervisor = Arc::new(EngineSupervisor::default());
        let key = EngineKey::new(
            "terminate-now-control-search".into(),
            "terminate-now-control-search".into(),
        )
        .unwrap();
        let terminate_started = Arc::new(AtomicBool::new(false));
        let read_started = Arc::new(AtomicBool::new(false));
        let (actor, _) = observed_terminate_failure_actor(
            CAUSE,
            terminate_started.clone(),
            Some(Duration::from_millis(40)),
            &["uciok", "readyok"],
            Some(read_started.clone()),
        );
        let supervised = supervisor
            .replace_handle(
                key.clone(),
                actor.clone(),
                key.engine.clone(),
                path_ref("control-search"),
            )
            .await
            .expect("register test actor");
        assert!(registration_cleanup_messages(&key, supervised.generation).is_empty());
        actor.init_uci().await.expect("complete UCI setup");
        let request = actor
            .start_search(&GoMode::Infinite)
            .await
            .expect("start search");
        let search_read = tokio::spawn({
            let actor = actor.clone();
            async move { actor.next_search_line(request).await }
        });
        wait_for_flag(&read_started, "search read to become pending").await;

        let termination = tokio::spawn({
            let supervisor = supervisor.clone();
            let key = key.clone();
            async move {
                RegistrationGuard::new(supervisor, key, supervised.generation)
                    .terminate_now()
                    .await
            }
        });
        wait_for_flag(&terminate_started, "control-channel termination").await;
        termination.abort();
        let _ = termination.await;
        let _ = search_read.await;
        wait_for_registration_removed(&supervisor, &key, supervised.generation).await;
        let messages =
            wait_for_registration_cleanup_cause(&key, supervised.generation, CAUSE).await;
        assert!(messages.iter().all(|message| message.contains(CAUSE)));
    }

    #[tokio::test]
    async fn terminate_now_logs_command_failure_during_active_search() {
        const CAUSE: &str = "terminate-now-command-channel-failure-cause";
        let supervisor = Arc::new(EngineSupervisor::default());
        let key = EngineKey::new(
            "terminate-now-command-search".into(),
            "terminate-now-command-search".into(),
        )
        .unwrap();
        let terminate_started = Arc::new(AtomicBool::new(false));
        let read_started = Arc::new(AtomicBool::new(false));
        let (actor, _) = observed_terminate_failure_actor(
            CAUSE,
            terminate_started.clone(),
            Some(Duration::from_millis(40)),
            &["uciok", "readyok"],
            Some(read_started.clone()),
        );
        let supervised = supervisor
            .replace_handle(
                key.clone(),
                actor.clone(),
                key.engine.clone(),
                path_ref("command-search"),
            )
            .await
            .expect("register test actor");
        assert!(registration_cleanup_messages(&key, supervised.generation).is_empty());
        actor.init_uci().await.expect("complete UCI setup");
        let request = actor
            .start_search(&GoMode::Infinite)
            .await
            .expect("start search");
        let search_read = tokio::spawn({
            let actor = actor.clone();
            async move { actor.next_search_line(request).await }
        });
        wait_for_flag(&read_started, "search read to become pending").await;

        let (reply_tx, reply_rx) = oneshot::channel();
        actor
            .tx
            .send(EngineCommand::Terminate(reply_tx))
            .await
            .expect("queue normal-channel termination");
        drop(reply_rx);
        wait_for_flag(&terminate_started, "normal-channel termination").await;
        let messages =
            wait_for_registration_cleanup_cause(&key, supervised.generation, CAUSE).await;
        let error = supervisor
            .terminate_exact(&key, supervised.generation)
            .await
            .expect_err("the later terminator must report the failed reap");
        assert!(error.diagnostic().contains(CAUSE));
        assert!(supervisor.get_exact(&key).is_none());
        assert!(actor
            .terminate()
            .await
            .unwrap_err()
            .diagnostic()
            .contains(CAUSE));
        wait_for_registration_removed(&supervisor, &key, supervised.generation).await;
        let _ = search_read.await;
        assert!(messages.iter().all(|message| message.contains(CAUSE)));
    }

    #[tokio::test]
    async fn publish_admitted_rejection_binds_identity_before_cleanup() {
        const CAUSE: &str = "publish-admitted-rejection-failure-cause";
        let supervisor = EngineSupervisor::default();
        let key = EngineKey::new(
            "publish-admitted-rejection".into(),
            "publish-admitted-rejection".into(),
        )
        .unwrap();
        let admission = supervisor
            .admit(
                key.clone(),
                key.engine.clone(),
                path_ref("publish-admitted-rejection"),
                false,
            )
            .await
            .expect("admission must be allocated before retirement");
        let generation = admission.generation();
        let started = Arc::new(AtomicBool::new(false));
        let (actor, _) = observed_terminate_failure_actor(CAUSE, started, None, &[], None);
        assert!(registration_cleanup_messages(&key, generation).is_empty());
        supervisor
            .retire_engine(key.engine.clone())
            .await
            .expect("retire the admitted engine before publication");

        match supervisor
            .publish_admitted(
                key.clone(),
                supervisor.track_pending_actor(key.clone(), actor, &admission),
                admission,
            )
            .await
        {
            Err(Error::OperationAndCleanup { primary, cleanup }) => {
                assert_eq!(primary, Error::EngineRetired.to_string());
                assert!(cleanup.contains(CAUSE));
            }
            other => panic!(
                "expected rejected publication cleanup error, got {:?}",
                other.map(|_| ())
            ),
        }
        assert!(supervisor.get_exact(&key).is_none());
        let messages = registration_cleanup_messages(&key, generation);
        assert!(messages.iter().any(|message| message.contains(CAUSE)));
    }

    #[test]
    fn combine_shutdown_results_preserves_primary_and_cleanup_diagnostics() {
        const PRIMARY: &str = "combine-shutdown-primary-io-cause";
        const CLEANUP: &str = "combine-shutdown-cleanup-io-cause";
        let error = combine_shutdown_results(
            Err(io::Error::other(PRIMARY).into()),
            Err(io::Error::other(CLEANUP).into()),
        )
        .expect_err("both shutdown operations fail");

        match error {
            Error::OperationAndCleanup { primary, cleanup } => {
                assert!(primary.contains(PRIMARY));
                assert!(cleanup.contains(CLEANUP));
                assert!(!primary.contains(CLEANUP));
                assert!(!cleanup.contains(PRIMARY));
            }
            other => panic!("expected combined shutdown error, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn recover_failed_protocol_preserves_operation_and_termination_roles() {
        let mut runtime = EngineRuntime::new(
            Box::new(TypedTerminateErrorIo {
                failure: TypedTerminateFailure::Timeout,
                terminate_calls: Arc::new(AtomicUsize::new(0)),
            }),
            EngineDeadlines::default(),
        );
        let registration_identity = OnceLock::new();
        let result = recover_failed_protocol::<()>(
            &mut runtime,
            &registration_identity,
            Err(Error::Conflict("protocol operation sentinel".into())),
        )
        .await;

        match result {
            Err(Error::OperationAndCleanup { primary, cleanup }) => {
                assert_eq!(primary, "Conflict: protocol operation sentinel");
                assert_eq!(cleanup, "Engine timeout: typed timeout sentinel");
            }
            other => panic!("expected protocol and termination failure, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn recover_failed_protocol_logs_termination_failure_for_bound_actor() {
        const OPERATION: &str = "recover-protocol-operation-os-cause";
        const TERMINATION: &str = "recover-protocol-termination-os-cause";
        let supervisor = EngineSupervisor::default();
        let key = EngineKey::new(
            "recover-protocol-bound-actor".into(),
            "recover-protocol-bound-actor-engine".into(),
        )
        .unwrap();
        let actor = Arc::new(EngineActor::new(
            Box::new(ProtocolAndTerminationErrorIo {
                operation_error: OPERATION.into(),
                termination_error: TERMINATION.into(),
            }),
            EngineDeadlines::default(),
        ));
        let supervised = supervisor
            .replace_handle(
                key.clone(),
                actor.clone(),
                key.engine.clone(),
                path_ref("recover-protocol-bound-actor-executable"),
            )
            .await
            .unwrap();
        let generation = supervised.generation;
        assert!(registration_cleanup_messages(&key, generation).is_empty());

        let error = actor
            .start_search(&GoMode::Depth(1))
            .await
            .expect_err("the injected go write fails and cleanup also fails");

        match error {
            error @ Error::EngineFailure { .. } => {
                assert!(operation_cause(&error).diagnostic().contains(OPERATION));
                assert!(error.diagnostic().contains(TERMINATION));
                assert!(error.engine_failure_snapshot().is_some());
            }
            other => panic!("expected protocol and termination failure, got {other:?}"),
        }
        let messages = registration_cleanup_messages(&key, generation);
        assert_eq!(messages.len(), 1);
        assert!(messages[0].contains(TERMINATION));
        let error = supervisor
            .terminate_exact(&key, generation)
            .await
            .expect_err("the exited actor retains its failed reap outcome");
        assert!(error.diagnostic().contains(TERMINATION));
    }

    #[tokio::test]
    async fn pending_actor_termination_log_carries_key_and_generation() {
        let supervisor = EngineSupervisor::default();
        let key = EngineKey::new("pending-log-tab".into(), "pending-log-engine".into()).unwrap();
        let actor = Arc::new(EngineActor::new(
            Box::new(TerminateErrorIo),
            EngineDeadlines::default(),
        ));
        supervisor.next_generation.store(41, Ordering::SeqCst);
        let admission = supervisor
            .admit(
                key.clone(),
                key.engine.clone(),
                path_ref("pending-log-path"),
                false,
            )
            .await
            .unwrap();
        assert_eq!(admission.generation(), 42);
        let pending = supervisor.track_pending_actor(key, actor, &admission);
        drop(PendingActorGuard::new(
            pending,
            supervisor.pending_actors.clone(),
        ));

        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                let logged = match PENDING_ACTOR_CLEANUP_ERRORS.lock() {
                    Ok(errors) => errors.clone(),
                    Err(poisoned) => poisoned.into_inner().clone(),
                };
                let assigned = logged.iter().any(|message| {
                    message.starts_with("engine actor termination failed for ")
                        && message.contains("pending-log-tab:pending-log-engine")
                        && message.contains("generation=42")
                        && message.contains("category=I/O failure")
                });
                if assigned {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("pending actor termination failure must carry its ownership identity");
    }
    #[tokio::test]
    async fn start_search_stop_timeout_reaps_the_actor_instead_of_accepting_another_go() {
        let ((actor, writes), terminated) =
            actor_with(&[], false, Some(Duration::from_millis(200)));
        actor.start_search(&GoMode::Depth(1)).await.unwrap();
        let error = actor.start_search(&GoMode::Depth(2)).await.unwrap_err();
        assert!(matches!(
            operation_cause(&error),
            Error::EngineTimeout(message) if message == "waiting for bestmove after stop"
        ));
        assert!(matches!(
            actor
                .start_search(&GoMode::Depth(3))
                .await
                .as_ref()
                .map_err(operation_cause),
            Err(Error::EngineDisconnected)
        ));
        let writes = writes.lock().await;
        assert_eq!(
            writes.iter().filter(|line| line.starts_with("go ")).count(),
            1
        );
        drop(writes);
        assert!(terminated.load(AtomicOrdering::SeqCst) >= 1);
    }

    #[tokio::test]
    async fn replacement_waits_for_old_bestmove_before_go() {
        let (actor, writes) = actor(&["bestmove e2e4", "readyok"]);
        let first = actor.start_search(&GoMode::Depth(1)).await.unwrap();
        let second = actor.start_search(&GoMode::Depth(2)).await.unwrap();
        assert_ne!(first, second);
        assert_eq!(
            *writes.lock().await,
            vec!["go depth 1", "stop", "isready", "go depth 2"]
        );
    }

    #[tokio::test]
    async fn trailing_output_of_a_finished_search_is_not_the_next_searchs_result() {
        let (actor, writes) = actor(&[
            "bestmove e2e4",
            // Emitted by the first search after its `bestmove`, still unread
            // when the second search starts.
            "info depth 9 score cp 12 pv h2h4",
            "bestmove h2h4",
            "readyok",
            "bestmove d2d4",
        ]);
        let first = actor.start_search(&GoMode::Depth(1)).await.unwrap();
        assert_eq!(
            actor.next_search_line(first).await.unwrap(),
            Some("bestmove e2e4".into())
        );

        let second = actor.start_search(&GoMode::Depth(2)).await.unwrap();
        assert_eq!(
            actor.next_search_line(second).await.unwrap(),
            Some("bestmove d2d4".into())
        );
        assert_eq!(
            *writes.lock().await,
            vec!["go depth 1", "isready", "go depth 2"]
        );
    }

    #[tokio::test]
    async fn a_ready_barrier_during_a_search_does_not_close_its_output() {
        let (actor, writes) = actor(&[
            "readyok",
            "bestmove e2e4",
            "bestmove h2h4",
            "readyok",
            "bestmove d2d4",
        ]);
        actor.start_search(&GoMode::Depth(1)).await.unwrap();
        actor.ensure_ready().await.unwrap();

        let second = actor.start_search(&GoMode::Depth(2)).await.unwrap();
        assert_eq!(
            actor.next_search_line(second).await.unwrap(),
            Some("bestmove d2d4".into())
        );
        assert_eq!(
            *writes.lock().await,
            vec!["go depth 1", "isready", "stop", "isready", "go depth 2"]
        );
    }

    #[tokio::test]
    async fn a_failed_ready_barrier_refuses_the_next_search() {
        let (actor, writes) = actor(&["bestmove e2e4"]);
        let first = actor.start_search(&GoMode::Depth(1)).await.unwrap();
        assert_eq!(
            actor.next_search_line(first).await.unwrap(),
            Some("bestmove e2e4".into())
        );

        // No `readyok` follows: the barrier cannot prove the pipe is clean, so
        // no `go` may be written on it.
        assert!(matches!(
            actor
                .start_search(&GoMode::Depth(2))
                .await
                .as_ref()
                .map_err(operation_cause),
            Err(Error::EngineDisconnected)
        ));
        assert_eq!(*writes.lock().await, vec!["go depth 1", "isready"]);
    }

    #[tokio::test]
    async fn an_idle_ready_barrier_before_go_is_not_repeated() {
        let (actor, writes) =
            actor(&["bestmove e2e4", "bestmove h2h4", "readyok", "bestmove d2d4"]);
        let first = actor.start_search(&GoMode::Depth(1)).await.unwrap();
        assert_eq!(
            actor.next_search_line(first).await.unwrap(),
            Some("bestmove e2e4".into())
        );

        actor.ensure_ready().await.unwrap();
        let second = actor.start_search(&GoMode::Depth(2)).await.unwrap();
        assert_eq!(
            actor.next_search_line(second).await.unwrap(),
            Some("bestmove d2d4".into())
        );
        assert_eq!(
            *writes.lock().await,
            vec!["go depth 1", "isready", "go depth 2"]
        );
    }
    #[tokio::test]
    async fn eof_is_disconnect_not_empty_success() {
        let (actor, _) = actor(&[]);
        let id = actor.start_search(&GoMode::Depth(1)).await.unwrap();
        assert!(matches!(
            actor
                .next_search_line(id)
                .await
                .as_ref()
                .map_err(operation_cause),
            Err(Error::EngineDisconnected)
        ));
    }

    #[tokio::test]
    async fn disconnected_logs_are_an_error() {
        let (actor, _) = actor(&[]);
        actor.terminate().await.unwrap();
        assert!(matches!(actor.logs().await, Err(Error::EngineDisconnected)));
    }

    #[tokio::test]
    async fn registered_initialization_is_visible_and_cancellation_removes_it() {
        let supervisor = Arc::new(EngineSupervisor::default());
        let key = EngineKey::new("tab".into(), "engine".into()).unwrap();
        let ((actor, _), _) =
            actor_with(&["uciok", "readyok"], false, Some(Duration::from_secs(60)));
        let initialization = tokio::spawn({
            let supervisor = supervisor.clone();
            let key = key.clone();
            async move {
                initialize_registered_actor(
                    supervisor,
                    key,
                    Arc::new(actor),
                    "engine".into(),
                    path_ref("engine-path"),
                    |actor| async move { actor.init_uci().await },
                )
                .await
                .map(|(_, mut guard, ())| guard.disarm())
            }
        });

        tokio::time::timeout(Duration::from_secs(1), async {
            while supervisor.get_exact(&key).is_none() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("actor must be registered while uciok is pending");

        initialization.abort();
        let _ = initialization.await;
        tokio::time::timeout(Duration::from_secs(1), async {
            while supervisor.get_exact(&key).is_some() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("registration guard must remove a cancelled initialization");
    }

    #[tokio::test]
    async fn dropped_replacement_waiting_for_registration_reaps_actor_and_admission() {
        let supervisor = Arc::new(EngineSupervisor::default());
        let key = EngineKey::new("tab".into(), "engine".into()).unwrap();
        let registration = supervisor.registration.lock().await;
        let ((actor, _), terminated) = actor_with(&[], false, None);
        let replacement = tokio::spawn({
            let supervisor = supervisor.clone();
            let key = key.clone();
            async move {
                supervisor
                    .replace_handle(
                        key,
                        Arc::new(actor),
                        "engine".into(),
                        path_ref("engine-path"),
                    )
                    .await
            }
        });
        tokio::time::timeout(Duration::from_secs(1), async {
            while !supervisor.admissions.contains_key(&key) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("admission must be visible before the registration wait");

        replacement.abort();
        let _ = replacement.await;
        drop(registration);
        tokio::time::timeout(Duration::from_secs(1), async {
            while !supervisor.admissions.is_empty() || terminated.load(AtomicOrdering::SeqCst) == 0
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("dropping the replacement must reclaim its admission and actor");
        assert_eq!(terminated.load(AtomicOrdering::SeqCst), 1);
        assert!(supervisor.get_exact(&key).is_none());
    }

    #[tokio::test]
    async fn terminate_all_reaps_an_actor_awaiting_uciok() {
        let supervisor = Arc::new(EngineSupervisor::default());
        let key = EngineKey::new("engine-config".into(), "probe".into()).unwrap();
        let ((actor, _), terminated) =
            actor_with(&["uciok", "readyok"], false, Some(Duration::from_secs(60)));
        let initialization = tokio::spawn({
            let supervisor = supervisor.clone();
            let key = key.clone();
            async move {
                initialize_registered_actor(
                    supervisor,
                    key,
                    Arc::new(actor),
                    "probe".into(),
                    path_ref("shared-path"),
                    |actor| async move { actor.init_uci().await },
                )
                .await
                .map(|(_, mut guard, ())| guard.disarm())
            }
        });
        while supervisor.get_exact(&key).is_none() {
            tokio::task::yield_now().await;
        }

        supervisor.terminate_all().await.unwrap();

        assert!(supervisor.get_exact(&key).is_none());
        assert_eq!(terminated.load(AtomicOrdering::SeqCst), 1);
        assert!(initialization.await.unwrap().is_err());
    }

    #[tokio::test]
    async fn two_probe_keys_can_share_one_executable_path_ref() {
        let supervisor = Arc::new(EngineSupervisor::default());
        let shared_path = path_ref("shared-path");
        let mut initializations = Vec::new();
        let mut keys = Vec::new();
        for probe in ["probe-1", "probe-2"] {
            let key = EngineKey::new("engine-config".into(), probe.into()).unwrap();
            let ((actor, _), _) =
                actor_with(&["uciok", "readyok"], false, Some(Duration::from_secs(60)));
            initializations.push(tokio::spawn({
                let supervisor = supervisor.clone();
                let key = key.clone();
                let shared_path = shared_path.clone();
                async move {
                    initialize_registered_actor(
                        supervisor,
                        key,
                        Arc::new(actor),
                        probe.into(),
                        shared_path,
                        |actor| async move { actor.init_uci().await },
                    )
                    .await
                    .map(|(_, mut guard, ())| guard.disarm())
                }
            }));
            keys.push(key);
        }
        tokio::time::timeout(Duration::from_secs(1), async {
            while keys.iter().any(|key| supervisor.get_exact(key).is_none()) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("both probes must publish independently");

        for initialization in initializations {
            initialization.abort();
            let _ = initialization.await;
        }
        tokio::time::timeout(Duration::from_secs(1), async {
            while keys.iter().any(|key| supervisor.get_exact(key).is_some()) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn warm_handoff_completes_a_pending_read_before_options_and_stale_waiters_cannot_stop_b()
    {
        let started = Arc::new(AtomicBool::new(false));
        let (actor, writes) = delayed_search_actor(
            &["bestmove e2e4", "readyok", "info depth 2", "bestmove d2d4"],
            Duration::from_millis(50),
            Some(started.clone()),
        );
        let actor = Arc::new(actor);
        let a = actor.start_search(&GoMode::Depth(1)).await.unwrap();
        let (reply, mut pending_read) = oneshot::channel();
        actor
            .tx
            .send(EngineCommand::NextSearch { id: a, reply })
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(1), async {
            while !started.load(Ordering::SeqCst) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        actor.stop_current().await.unwrap();
        assert!(matches!(pending_read.try_recv(), Ok(Ok(None))));
        actor.set_option("Threads", "4").await.unwrap();
        actor
            .set_position(
                "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
                &[],
            )
            .await
            .unwrap();
        let b = actor.start_search(&GoMode::Depth(2)).await.unwrap();
        started.store(false, Ordering::SeqCst);
        let (reply, pending_b) = oneshot::channel();
        actor
            .tx
            .send(EngineCommand::NextSearch { id: b, reply })
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(1), async {
            while !started.load(Ordering::SeqCst) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let cancelled = AtomicBool::new(true);
        assert!(matches!(
            actor.next_search_line_cancellable(a, &cancelled).await,
            Err(Error::AnalysisCancelled)
        ));
        let token = CancellationToken::new();
        token.cancel();
        assert!(matches!(
            actor.wait_bestmove_cancellable(a, &token).await,
            Err(Error::AnalysisCancelled)
        ));
        assert_eq!(actor.next_search_line(a).await.unwrap(), None);
        assert_eq!(
            pending_b.await.unwrap().unwrap(),
            Some("info depth 2".into())
        );
        assert_eq!(
            writes
                .lock()
                .await
                .iter()
                .filter(|line| *line == "stop")
                .count(),
            1
        );
        actor.stop_request(b).await.unwrap();
        actor.terminate().await.unwrap();
    }

    #[tokio::test]
    async fn stale_exact_stop_leaves_reused_actor_published() {
        let supervisor = Arc::new(EngineSupervisor::default());
        let key = EngineKey::new("stale-stop".into(), "engine".into()).unwrap();
        let ((actor, _), terminated) = actor_with(&[], false, None);
        let current = supervisor.replace(key.clone(), actor).await.unwrap();
        let first = SupervisedSearch::new(100, Arc::new(AtomicBool::new(false)));
        current.bind_search(first.clone());
        let lifecycle = supervisor.lifecycle_lease(&key);
        let transition = lifecycle.lock().await;
        let stop = tokio::spawn({
            let supervisor = supervisor.clone();
            let key = key.clone();
            async move { supervisor.stop_search(&key, Some(first.generation)).await }
        });
        wait_for_flag(&first.cancelled, "stale stop to capture the first search").await;
        assert!(!stop.is_finished());
        let second = SupervisedSearch::new(101, Arc::new(AtomicBool::new(false)));
        current.bind_search(second.clone());
        assert!(!second.cancelled.load(Ordering::SeqCst));
        assert!(!current.cancelled.load(Ordering::SeqCst));
        drop(transition);

        assert!(!pending_test_wait(stop).await.unwrap().unwrap());
        assert_eq!(
            supervisor.get_exact(&key).unwrap().generation,
            current.generation
        );
        assert!(!second.cancelled.load(Ordering::SeqCst));
        assert!(!current.cancelled.load(Ordering::SeqCst));
        assert_eq!(terminated.load(Ordering::SeqCst), 0);
        supervisor
            .release_generation(&key, second.generation)
            .await
            .unwrap();
    }

    struct CancelledWriteIo {
        io: FakeIo,
        cancelled: Arc<AtomicBool>,
        cancel_command: &'static str,
        terminate_error: Option<&'static str>,
    }

    #[async_trait]
    impl UciIo for CancelledWriteIo {
        async fn write_line(&mut self, line: &str) -> Result<(), Error> {
            self.io.write_line(line).await?;
            if line == self.cancel_command {
                assert!(!self.cancelled.load(Ordering::SeqCst));
                self.cancelled.store(true, Ordering::SeqCst);
                return Err(Error::EngineDisconnected);
            }
            Ok(())
        }

        async fn read_line(&mut self) -> Result<Option<String>, Error> {
            self.io.read_line().await
        }

        async fn terminate(&mut self, quit: Duration, reap: Duration) -> Result<(), Error> {
            self.io.terminate(quit, reap).await?;
            match self.terminate_error {
                Some(error) => Err(io::Error::other(error).into()),
                None => Ok(()),
            }
        }
    }

    #[tokio::test]
    async fn kill_engine_cancelled_warm_start_returns_cancellation() {
        // The option writer cancels the exact search flag after WarmEngine::start begins.
        let result = cancelled_interactive_start_with_write_failure(
            "cancelled-warm-start",
            "setoption name UCI_Chess960 value false",
            true,
            None,
        )
        .await;
        assert!(matches!(result, Err(Error::Cancellation)));
    }

    async fn cancelled_interactive_start_with_write_failure(
        tab: &str,
        cancel_command: &'static str,
        warm: bool,
        terminate_error: Option<&'static str>,
    ) -> Result<
        (
            crate::chess::EngineProcess,
            SupervisedEngine,
            SupervisedSearch,
        ),
        Error,
    > {
        let supervisor = Arc::new(EngineSupervisor::default());
        let key = EngineKey::new(tab.into(), "engine".into()).unwrap();
        let (_launch_directory, engine, authority) = if warm {
            (
                None,
                EngineHandle {
                    id: path_ref("cancelled-start-image"),
                    kind: crate::infra::path_authority::EngineHandleKind::Engine,
                },
                None,
            )
        } else {
            let directory = tempfile::tempdir().unwrap();
            let engine_file = directory.path().join("cancelled-init-engine");
            std::fs::write(&engine_file, b"fake engine bytes").unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&engine_file, std::fs::Permissions::from_mode(0o700))
                    .unwrap();
            }
            let mut authority = PathAuthority::open_for_engine_test(directory.path()).unwrap();
            let engine = authority
                .register_engine_file(&engine_file, "cancelled-init-engine")
                .unwrap();
            (Some(directory), engine, Some(authority))
        };
        let executable = engine.id.clone();
        let writes = Arc::new(Mutex::new(Vec::new()));
        let cancelled = Arc::new(AtomicBool::new(false));
        let actor = Arc::new(EngineActor::new(
            Box::new(CancelledWriteIo {
                io: FakeIo::new(
                    writes.clone(),
                    [Some("uciok".into()), Some("readyok".into())],
                ),
                cancelled: cancelled.clone(),
                cancel_command,
                terminate_error,
            }),
            EngineDeadlines::default(),
        ));
        let _spawn_override = if warm {
            let current = supervisor
                .replace_handle(
                    key.clone(),
                    actor.clone(),
                    key.engine.clone(),
                    executable.clone(),
                )
                .await
                .unwrap();
            *current.interactive.lock().await = Some(
                crate::chess::WarmEngine::new(actor.clone(), Vec::new(), &cancelled)
                    .await
                    .unwrap(),
            );
            if cancel_command == "stop" {
                actor.start_search(&GoMode::Infinite).await.unwrap();
            }
            None
        } else {
            assert!(supervisor.get_exact(&key).is_none());
            Some(SpawnActorOverrideGuard::new(
                Arc::try_unwrap(actor)
                    .ok()
                    .expect("the fresh actor must have one owner"),
            ))
        };
        let mut admission = supervisor
            .admit(key.clone(), key.engine.clone(), executable.clone(), false)
            .await
            .unwrap();
        admission.admission.cancelled = cancelled.clone();
        supervisor
            .admissions
            .insert(key.clone(), admission.admission.clone());
        assert!(!cancelled.load(Ordering::SeqCst));
        let result = supervisor
            .start_interactive_search(
                key.clone(),
                engine,
                match authority {
                    Some(authority) => {
                        crate::infra::path_authority::SharedPathAuthority::installed(authority)
                    }
                    None => crate::infra::path_authority::SharedPathAuthority::uninitialized(),
                },
                admission,
                crate::chess::EngineOptions {
                    fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1".into(),
                    ..crate::chess::EngineOptions::default()
                },
                &GoMode::Infinite,
            )
            .await;
        assert!(cancelled.load(Ordering::SeqCst));
        assert!(writes
            .lock()
            .await
            .iter()
            .any(|line| line == cancel_command));
        assert!(supervisor.get_exact(&key).is_none());
        if !warm {
            assert!(SPAWN_ACTOR_OVERRIDE.with(|slot| slot.borrow().is_none()));
        }
        result
    }

    #[tokio::test]
    async fn kill_engine_cancelled_stop_returns_cancellation() {
        let result =
            cancelled_interactive_start_with_write_failure("cancelled-stop", "stop", true, None)
                .await;
        assert!(matches!(result, Err(Error::Cancellation)));
    }

    #[tokio::test]
    async fn kill_engine_cancelled_init_returns_cancellation() {
        let result =
            cancelled_interactive_start_with_write_failure("cancelled-init", "uci", false, None)
                .await;
        assert!(matches!(result, Err(Error::Cancellation)));
    }

    #[tokio::test]
    async fn kill_engine_cancelled_warm_start_keeps_cleanup_failure() {
        let result = cancelled_interactive_start_with_write_failure(
            "cancelled-warm-start-cleanup",
            "setoption name UCI_Chess960 value false",
            true,
            Some("fake cancelled warm-start terminate failed"),
        )
        .await;
        match result {
            Err(Error::OperationAndCleanup { primary, cleanup }) => {
                assert!(primary.contains("Cancellation"));
                assert!(cleanup.contains("fake cancelled warm-start terminate failed"));
            }
            _ => panic!("expected cancellation with a termination failure"),
        }
    }

    #[tokio::test]
    async fn warm_search_barriers_cancel_dequeued_info_and_terminal_payloads_before_successor() {
        let supervisor = EngineSupervisor::default();
        let key = EngineKey::new("barriers".into(), "id".into()).unwrap();
        let (actor, _) = EngineActor::recording_test_actor(&[]);
        let current = supervisor
            .replace_handle(
                key.clone(),
                actor,
                "id".into(),
                PathRef {
                    id: "binary".into(),
                },
            )
            .await
            .unwrap();
        let a = SupervisedSearch::new(100, Arc::new(AtomicBool::new(false)));
        let b = SupervisedSearch::new(101, Arc::new(AtomicBool::new(false)));
        current.bind_search(a.clone());
        let mut old_snapshot = current.clone();
        old_snapshot.search = Arc::new(StdMutex::new(Some(a.clone())));
        assert!(old_snapshot.try_publish(|| Ok::<_, Error>(())).unwrap());
        current.bind_search(b.clone());
        for _ in ["info", "bestmove"] {
            assert!(!old_snapshot.try_publish(|| Ok::<_, Error>(())).unwrap());
        }
        assert!(current.try_publish(|| Ok::<_, Error>(())).unwrap());
        supervisor.stop_generation(&key, Some(100)).await.unwrap();
        supervisor.release_generation(&key, 100).await.unwrap();
        assert!(!b.cancelled.load(Ordering::SeqCst));
        assert!(supervisor.get_exact(&key).is_some());
        supervisor.release_generation(&key, 101).await.unwrap();
        assert!(b.cancelled.load(Ordering::SeqCst));
        assert!(supervisor.get_exact(&key).is_none());
    }

    #[tokio::test]
    async fn warm_qualified_stop_and_release_failures_remove_the_actor() {
        for release in [false, true] {
            let supervisor = EngineSupervisor::default();
            let key = EngineKey::new("failed-warm-stop".into(), "engine".into()).unwrap();
            let ((actor, _), terminated) = fake_actor_with_config(
                &[],
                false,
                true,
                None,
                None,
                None,
                EngineDeadlines::default(),
            );
            let current = supervisor.replace(key.clone(), actor).await.unwrap();
            current.bind_search(SupervisedSearch::new(100, Arc::new(AtomicBool::new(false))));
            current.actor.start_search(&GoMode::Infinite).await.unwrap();
            let result = if release {
                supervisor.release_generation(&key, 100).await
            } else {
                supervisor.stop_generation(&key, Some(100)).await
            };
            assert!(result.is_err());
            assert!(supervisor.get_exact(&key).is_none());
            assert_eq!(terminated.load(Ordering::SeqCst), 1);
        }
    }

    #[tokio::test]
    async fn search_registration_guard_drop_preserves_successor_and_explicit_cleanup_releases_owner(
    ) {
        let supervisor = Arc::new(EngineSupervisor::default());
        let key = EngineKey::new("search-guard".into(), "engine".into()).unwrap();
        let (actor, _) = EngineActor::recording_test_actor(&[]);
        let current = supervisor
            .replace_handle(
                key.clone(),
                actor,
                "engine".into(),
                PathRef {
                    id: "binary".into(),
                },
            )
            .await
            .unwrap();
        current.bind_search(SupervisedSearch::new(100, Arc::new(AtomicBool::new(false))));
        let guard = RegistrationGuard::for_search(supervisor.clone(), key.clone(), 100);
        current.bind_search(SupervisedSearch::new(101, Arc::new(AtomicBool::new(false))));
        drop(guard);
        tokio::task::yield_now().await;
        assert!(supervisor.get_exact(&key).is_some());
        RegistrationGuard::for_search(supervisor.clone(), key.clone(), 101)
            .terminate_now()
            .await
            .unwrap();
        assert!(supervisor.get_exact(&key).is_none());
    }

    #[tokio::test]
    async fn cancellation_stops_the_exact_active_request() {
        let (actor, writes) = actor(&["bestmove e2e4"]);
        let id = actor.start_search(&GoMode::Depth(1)).await.unwrap();
        let cancelled = std::sync::atomic::AtomicBool::new(true);
        assert!(matches!(
            actor.next_search_line_cancellable(id, &cancelled).await,
            Err(Error::AnalysisCancelled)
        ));
        assert_eq!(*writes.lock().await, vec!["go depth 1", "stop"]);
    }

    #[tokio::test]
    async fn cancellable_search_read_keeps_one_pending_request_across_poll_ticks() {
        let read_attempts = Arc::new(AtomicUsize::new(0));
        let (actor, writes) = delayed_search_actor_with_attempts(
            &["info depth 1", "bestmove e2e4"],
            Duration::from_millis(120),
            None,
            Some(read_attempts.clone()),
        );
        let id = actor.start_search(&GoMode::Depth(1)).await.unwrap();
        let cancelled = std::sync::atomic::AtomicBool::new(false);

        assert_eq!(
            actor
                .next_search_line_cancellable(id, &cancelled)
                .await
                .unwrap(),
            Some("info depth 1".into())
        );
        assert_eq!(
            actor
                .next_search_line_cancellable(id, &cancelled)
                .await
                .unwrap(),
            Some("bestmove e2e4".into())
        );
        assert_eq!(*writes.lock().await, vec!["go depth 1"]);
        assert_eq!(read_attempts.load(AtomicOrdering::SeqCst), 2);
        actor.terminate().await.unwrap();
    }

    #[tokio::test]
    async fn a_live_concurrent_search_read_is_rejected_without_disturbing_the_first() {
        let read_started = Arc::new(AtomicBool::new(false));
        let (actor, _) = delayed_search_actor(
            &["info depth 1"],
            Duration::from_millis(120),
            Some(read_started.clone()),
        );
        let id = actor.start_search(&GoMode::Depth(1)).await.unwrap();
        let first = tokio::spawn({
            let actor = actor.clone();
            async move { actor.next_search_line(id).await }
        });
        tokio::time::timeout(Duration::from_secs(1), async {
            while !read_started.load(Ordering::SeqCst) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("the first read must be pending before the concurrent request");

        assert!(matches!(
            actor.next_search_line(id).await,
            Err(Error::Conflict(message))
                if message == "engine is busy searching; stop or terminate it first"
        ));
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(1), first)
                .await
                .expect("the first read must remain live")
                .unwrap()
                .unwrap(),
            Some("info depth 1".into())
        );
        actor.terminate().await.unwrap();
    }

    #[tokio::test]
    async fn a_closed_queued_search_read_does_not_consume_a_line() {
        let read_started = Arc::new(AtomicBool::new(false));
        let (actor, _) = delayed_search_actor(
            &["info depth 1", "bestmove e2e4"],
            Duration::from_millis(120),
            Some(read_started.clone()),
        );
        let id = actor.start_search(&GoMode::Depth(1)).await.unwrap();
        let first = tokio::spawn({
            let actor = actor.clone();
            async move { actor.next_search_line(id).await }
        });
        tokio::time::timeout(Duration::from_secs(1), async {
            while !read_started.load(Ordering::SeqCst) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("the first read must be pending before the queued request");

        let (reply_tx, reply) = oneshot::channel();
        actor
            .tx
            .send(EngineCommand::NextSearch {
                id,
                reply: reply_tx,
            })
            .await
            .unwrap();
        drop(reply);

        assert_eq!(
            tokio::time::timeout(Duration::from_secs(1), first)
                .await
                .expect("the first read must complete")
                .unwrap()
                .unwrap(),
            Some("info depth 1".into())
        );
        assert_eq!(
            actor.next_search_line(id).await.unwrap(),
            Some("bestmove e2e4".into())
        );
        actor.terminate().await.unwrap();
    }

    #[tokio::test]
    async fn cancellation_during_a_pending_search_read_stops_and_allows_a_new_search() {
        let read_started = Arc::new(AtomicBool::new(false));
        let (actor, writes) = delayed_search_actor(
            // `bestmove d2d4` is a duplicate the first search emits after
            // the one `stop` drained; the ready barrier must discard it.
            &["bestmove e2e4", "bestmove d2d4", "readyok", "bestmove g1f3"],
            Duration::from_millis(300),
            Some(read_started.clone()),
        );
        let id = actor.start_search(&GoMode::Depth(1)).await.unwrap();
        let cancelled = Arc::new(AtomicBool::new(false));
        let pending = tokio::spawn({
            let actor = actor.clone();
            let cancelled = cancelled.clone();
            async move {
                actor
                    .next_search_line_cancellable(id, cancelled.as_ref())
                    .await
            }
        });
        tokio::time::timeout(Duration::from_secs(1), async {
            while !read_started.load(Ordering::SeqCst) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("the delayed read must start before cancellation");
        tokio::time::sleep(Duration::from_millis(100)).await;
        cancelled.store(true, Ordering::SeqCst);

        assert!(matches!(
            tokio::time::timeout(Duration::from_secs(1), pending)
                .await
                .expect("cancellation must finish the pending read")
                .unwrap(),
            Err(Error::AnalysisCancelled)
        ));
        assert_eq!(*writes.lock().await, vec!["go depth 1", "stop"]);

        let new_id = actor.start_search(&GoMode::Depth(2)).await.unwrap();
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(1), actor.next_search_line(new_id))
                .await
                .expect("the new search read must complete")
                .unwrap(),
            Some("bestmove g1f3".into())
        );
        assert_eq!(
            *writes.lock().await,
            vec!["go depth 1", "stop", "isready", "go depth 2"]
        );
        actor.terminate().await.unwrap();
    }

    #[tokio::test]
    async fn dropped_search_reader_does_not_consume_the_next_engine_line() {
        let read_started = Arc::new(AtomicBool::new(false));
        let (actor, _) = delayed_search_actor(
            &["info depth 1"],
            Duration::from_millis(200),
            Some(read_started.clone()),
        );
        let id = actor.start_search(&GoMode::Depth(1)).await.unwrap();
        let pending = tokio::spawn({
            let actor = actor.clone();
            let cancelled = AtomicBool::new(false);
            async move { actor.next_search_line_cancellable(id, &cancelled).await }
        });
        tokio::time::timeout(Duration::from_secs(1), async {
            while !read_started.load(Ordering::SeqCst) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("the delayed read must start before the caller is dropped");
        tokio::time::sleep(Duration::from_millis(50)).await;
        pending.abort();
        assert!(pending.await.unwrap_err().is_cancelled());

        assert_eq!(
            tokio::time::timeout(Duration::from_secs(1), actor.next_search_line(id))
                .await
                .expect("the fresh read must complete")
                .unwrap(),
            Some("info depth 1".into())
        );
        actor.terminate().await.unwrap();
    }

    #[tokio::test]
    async fn sender_exhaustion_logs_idle_and_both_pending_search_failures() {
        for branch in ["idle", "pending-control", "pending-normal"] {
            let cause = format!("sender-exhaustion-{branch}-private-cause");
            let key =
                EngineKey::new(format!("sender-exhaustion-{branch}"), "engine".into()).unwrap();
            let started = Arc::new(AtomicBool::new(false));
            let reading = Arc::new(AtomicBool::new(false));
            let (actor, calls) = observed_terminate_failure_actor(
                &cause,
                started.clone(),
                None,
                &[],
                Some(reading.clone()),
            );
            actor.registration_identity.set((key.clone(), 981)).unwrap();
            let task = actor.task.clone();
            let outcome = actor.termination_outcome.clone();
            let control = (branch == "pending-normal").then(|| actor.control_tx.clone());
            let reply = if branch != "idle" {
                let id = actor.start_search(&GoMode::Infinite).await.unwrap();
                let (reply_tx, reply) = oneshot::channel();
                actor
                    .tx
                    .send(EngineCommand::NextSearch {
                        id,
                        reply: reply_tx,
                    })
                    .await
                    .unwrap();
                wait_for_flag(&reading, "pending sender-exhaustion read").await;
                Some(reply)
            } else {
                None
            };
            drop(actor);
            wait_for_flag(&started, "sender-exhaustion teardown").await;
            drop(control);
            timeout(Duration::from_secs(2), task.lock().await.take().unwrap())
                .await
                .unwrap()
                .unwrap();
            if let Some(reply) = reply {
                assert!(matches!(reply.await, Ok(Err(Error::EngineDisconnected))));
            }
            assert_eq!(calls.load(Ordering::SeqCst), 1);
            assert!(outcome
                .get()
                .unwrap()
                .as_ref()
                .unwrap_err()
                .diagnostic()
                .contains(&cause));
            let messages = registration_cleanup_messages(&key, 981);
            assert_eq!(messages.len(), 1, "{branch}: {messages:?}");
            assert!(messages[0].contains(&cause), "{branch}: {messages:?}");
        }
    }

    #[tokio::test]
    async fn cancelled_join_waiter_retains_panicking_actor_failure() {
        let capture = crate::error::LogCaptureScope::start();
        const CAUSE: &str = "cancelled-join-waiter-private-panic-path";
        let (actor, _) = EngineActor::recording_test_actor(&[]);
        let key =
            EngineKey::new("cancelled-join-tab".into(), "cancelled-join-engine".into()).unwrap();
        actor.registration_identity.set((key.clone(), 982)).unwrap();
        let original = actor.task.lock().await.take().unwrap();
        original.abort();
        let _ = original.await;
        let (release, released) = oneshot::channel();
        *actor.task.lock().await = Some(tokio::spawn(async move {
            released.await.unwrap();
            panic!("{CAUSE}");
        }));
        {
            let waiting = actor.reap_task();
            tokio::pin!(waiting);
            assert!(futures_util::poll!(&mut waiting).is_pending());
            assert!(actor.task.lock().await.is_none(), "join handle transferred");
            assert!(
                actor.joined.lock().unwrap().is_some(),
                "shared join retained before cancellation"
            );
        }
        release.send(()).unwrap();
        let first = actor.terminate().await.unwrap_err();
        let second = actor.terminate().await.unwrap_err();
        assert_same_termination_failure(&second, &first);
        let payload = serde_json::to_value(&first).unwrap();
        assert!(!payload.to_string().contains(CAUSE));
        assert!(first.diagnostic().contains("engine actor task failed"));
        let records = capture.messages();
        let records = records
            .iter()
            .filter(|line| line.contains("cancelled-join-tab:cancelled-join-engine generation=982"))
            .collect::<Vec<_>>();
        assert_eq!(records.len(), 1);
        assert!(records[0].contains(CAUSE));
    }

    #[tokio::test]
    async fn dropping_every_actor_handle_terminates_a_pending_search_read() {
        let read_started = Arc::new(AtomicBool::new(false));
        let ((actor, _), terminated) = fake_actor_with_config(
            &["info depth 1"],
            false,
            false,
            Some(Duration::from_secs(5)),
            read_observation(Some(read_started.clone()), None),
            None,
            EngineDeadlines {
                search: Duration::from_secs(1),
                stop: Duration::from_secs(1),
                ..EngineDeadlines::default()
            },
        );
        let actor_task = actor.task.clone();
        let id = actor.start_search(&GoMode::Depth(1)).await.unwrap();
        let (reply_tx, reply) = oneshot::channel();
        actor
            .tx
            .send(EngineCommand::NextSearch {
                id,
                reply: reply_tx,
            })
            .await
            .unwrap();
        let reading_task = tokio::spawn({
            let actor = actor.clone();
            async move {
                let _actor = actor;
                std::future::pending::<()>().await;
            }
        });
        tokio::time::timeout(Duration::from_secs(1), async {
            while !read_started.load(Ordering::SeqCst) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("the delayed read must start before the handles are dropped");
        reading_task.abort();
        let _ = reading_task.await;
        drop(actor);

        let terminated_in_time = tokio::time::timeout(Duration::from_millis(500), async {
            while terminated.load(AtomicOrdering::SeqCst) == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .is_ok();
        if !terminated_in_time {
            if let Some(task) = actor_task.lock().await.take() {
                task.abort();
                let _ = task.await;
            }
            panic!("actor did not terminate after every handle was dropped");
        }
        assert_eq!(terminated.load(AtomicOrdering::SeqCst), 1);
        let task = actor_task
            .lock()
            .await
            .take()
            .expect("the actor task must remain available for reaping");
        tokio::time::timeout(Duration::from_millis(500), task)
            .await
            .expect("the actor task must finish after channel closure")
            .expect("the actor task must not panic");
        assert!(matches!(reply.await, Ok(Err(Error::EngineDisconnected))));
    }

    #[tokio::test]
    async fn cancellation_returns_a_stop_error_and_reaps_the_actor() {
        let read_started = Arc::new(AtomicBool::new(false));
        let ((actor, _), terminated) = actor_with_stop_failure_and_pending_read(
            Duration::from_secs(1),
            Some(read_started.clone()),
        );
        let id = actor.start_search(&GoMode::Depth(1)).await.unwrap();
        let cancelled = Arc::new(AtomicBool::new(false));
        let pending = tokio::spawn({
            let actor = actor.clone();
            let cancelled = cancelled.clone();
            async move {
                actor
                    .next_search_line_cancellable(id, cancelled.as_ref())
                    .await
            }
        });
        tokio::time::timeout(Duration::from_secs(1), async {
            while !read_started.load(Ordering::SeqCst) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("the delayed read must start before cancellation");
        tokio::time::sleep(Duration::from_millis(30)).await;
        cancelled.store(true, Ordering::SeqCst);

        assert!(matches!(
            tokio::time::timeout(Duration::from_secs(1), pending)
                .await
                .expect("stop failure must finish the pending read")
                .unwrap()
                .as_ref()
                .map_err(operation_cause),
            Err(Error::Io(_))
        ));
        assert_eq!(terminated.load(AtomicOrdering::SeqCst), 1);
        assert!(matches!(
            actor
                .start_search(&GoMode::Depth(2))
                .await
                .as_ref()
                .map_err(operation_cause),
            Err(Error::EngineDisconnected)
        ));
    }

    #[tokio::test]
    async fn pending_search_read_honors_cancellation_within_the_poll_bound() {
        let read_started = Arc::new(AtomicBool::new(false));
        let (actor, _) = delayed_search_actor(
            &["bestmove e2e4"],
            Duration::from_secs(5),
            Some(read_started.clone()),
        );
        let id = actor.start_search(&GoMode::Depth(1)).await.unwrap();
        let cancelled = Arc::new(AtomicBool::new(false));
        let pending = tokio::spawn({
            let actor = actor.clone();
            let cancelled = cancelled.clone();
            async move {
                actor
                    .next_search_line_cancellable(id, cancelled.as_ref())
                    .await
            }
        });
        tokio::time::timeout(Duration::from_secs(1), async {
            while !read_started.load(Ordering::SeqCst) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("the delayed read must start before cancellation");
        tokio::time::sleep(Duration::from_millis(30)).await;
        cancelled.store(true, Ordering::SeqCst);

        assert!(matches!(
            tokio::time::timeout(Duration::from_millis(500), pending)
                .await
                .expect("cancellation must stay within the poll bound")
                .unwrap(),
            Err(Error::AnalysisCancelled)
        ));
        actor.terminate().await.unwrap();
    }

    #[tokio::test]
    async fn terminating_actor_preempts_a_pending_cancellable_search_read() {
        let read_started = Arc::new(AtomicBool::new(false));
        let (actor, _) = delayed_search_actor(
            &["bestmove e2e4"],
            Duration::from_secs(5),
            Some(read_started.clone()),
        );
        let id = actor.start_search(&GoMode::Depth(1)).await.unwrap();
        let cancelled = AtomicBool::new(false);
        let pending = tokio::spawn({
            let actor = actor.clone();
            async move { actor.next_search_line_cancellable(id, &cancelled).await }
        });
        tokio::time::timeout(Duration::from_secs(1), async {
            while !read_started.load(Ordering::SeqCst) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("the delayed read must start before termination");

        tokio::time::timeout(Duration::from_millis(500), actor.terminate())
            .await
            .expect("termination must preempt the pending read")
            .unwrap();
        assert!(matches!(
            pending.await.unwrap(),
            Err(Error::EngineDisconnected)
        ));
    }

    #[tokio::test]
    async fn failed_stop_reaps_the_actor_and_rejects_a_new_search() {
        let ((actor, _), terminate_calls) = actor_with_stop_failure(&[]);
        actor.start_search(&GoMode::Depth(1)).await.unwrap();
        assert!(actor.stop_current().await.is_err());
        assert_eq!(terminate_calls.load(AtomicOrdering::SeqCst), 1);
        assert!(matches!(
            actor
                .start_search(&GoMode::Depth(2))
                .await
                .as_ref()
                .map_err(operation_cause),
            Err(Error::EngineDisconnected)
        ));
    }
    #[tokio::test]
    async fn line_limited_logs_report_the_exact_drop_count() {
        let mut logs = BoundedLogs::default();
        for _ in 0..MAX_LOG_LINES + 10 {
            logs.push(EngineLog::Engine("line".into()));
        }
        assert_eq!(logs.entries.len(), MAX_LOG_LINES);
        assert!(logs.truncated);
        assert_eq!(logs.dropped_entries, 10);
        assert!(matches!(
            logs.entries().first(),
            Some(EngineLog::Truncated {
                dropped_entries: 10
            })
        ));
    }

    #[test]
    fn byte_limited_logs_report_the_exact_drop_count() {
        let mut logs = BoundedLogs::default();
        logs.push(EngineLog::Gui("a".repeat(MAX_LOG_BYTES / 2)));
        logs.push(EngineLog::Engine("b".repeat(MAX_LOG_BYTES / 2)));
        logs.push(EngineLog::Gui("c".into()));

        assert_eq!(logs.entries.len(), 2);
        assert_eq!(logs.bytes, MAX_LOG_BYTES / 2 + 1);
        assert_eq!(logs.dropped_entries, 1);
        assert!(matches!(
            logs.entries().first(),
            Some(EngineLog::Truncated { dropped_entries: 1 })
        ));
    }

    #[test]
    fn resource_redactions_sanitize_retained_lines_and_platform_path_shapes() {
        let unix = "/proc/self/fd/17".to_string();
        let windows = r"C:\tablebases\new".to_string();
        let multi = format!("{unix}:{windows}");
        let mut logs = BoundedLogs::default();
        logs.push(EngineLog::Gui(format!(
            "setoption name Book value {multi}\n"
        )));
        logs.push(EngineLog::Engine(format!("echo {multi}")));

        let mut redactions = ResourceRedactions::default();
        redactions
            .register(&[unix.clone(), windows.clone()], &mut logs)
            .unwrap();

        let entries = logs.entries();
        assert!(entries.iter().all(|entry| match entry {
            EngineLog::Gui(line) | EngineLog::Engine(line) => {
                !line.contains(&unix) && !line.contains(&windows)
            }
            EngineLog::Truncated { .. } => true,
        }));
        assert_eq!(redactions.redact(multi), "[redacted]:[redacted]");
    }

    #[test]
    fn resource_redaction_uses_registered_provenance_not_path_shape() {
        let registered = "/launch/root/authorized.leaf".to_string();
        let unregistered = "/launch/root/unregistered.leaf".to_string();
        let mut logs = BoundedLogs::default();
        logs.push(EngineLog::Gui(format!(
            "setoption name Book value {registered}:{unregistered}\n"
        )));
        let mut redactions = ResourceRedactions::default();
        redactions
            .register(std::slice::from_ref(&registered), &mut logs)
            .unwrap();
        assert!(logs.entries().iter().any(|entry| matches!(
            entry,
            EngineLog::Gui(line)
                if line == "setoption name Book value [redacted]:/launch/root/unregistered.leaf\n"
        )));
    }

    #[tokio::test]
    async fn resource_option_redacts_both_transcript_directions_after_a_swap() {
        let old_unix = "/proc/self/fd/17".to_string();
        let old_unix_other = "/proc/self/fd/18".to_string();
        let old_value = format!("{old_unix}:{old_unix_other}");
        let new_windows = r"C:\tablebases\new".to_string();
        let (actor, writes) = EngineActor::recording_test_actor(&[&old_value, &new_windows]);

        actor
            .set_option_with_resources("Book", &old_value, &[old_unix, old_unix_other])
            .await
            .unwrap();
        actor
            .set_option_with_resources("Book", &new_windows, std::slice::from_ref(&new_windows))
            .await
            .unwrap();
        actor.set_option("Threads", "4").await.unwrap();

        // The parser receives raw child lines even though the actor log is
        // sanitized, and the wire command remains byte-for-byte unchanged.
        assert_eq!(
            actor.next_configuration_line().await.unwrap(),
            Some(old_value.clone())
        );
        assert_eq!(
            actor.next_configuration_line().await.unwrap(),
            Some(new_windows.clone())
        );
        assert_eq!(
            *writes.lock().await,
            vec![
                format!("setoption name Book value {old_value}"),
                format!("setoption name Book value {new_windows}"),
                "setoption name Threads value 4".into(),
            ]
        );

        let logs = actor.logs().await.unwrap();
        assert!(logs.iter().all(|entry| match entry {
            EngineLog::Gui(line) | EngineLog::Engine(line) => {
                !line.contains("/proc/self/fd/") && !line.contains(r"C:\tablebases\new")
            }
            EngineLog::Truncated { .. } => true,
        }));
        assert!(logs.iter().any(|entry| matches!(
            entry,
            EngineLog::Gui(line) if line == "setoption name Threads value 4\n"
        )));
        actor.terminate().await.unwrap();
    }

    #[tokio::test]
    async fn resource_redaction_budget_fails_before_sending_a_new_value() {
        let mut redactions = ResourceRedactions::default();
        let mut logs = BoundedLogs::default();
        let oversized = "x".repeat(MAX_RESOURCE_REDACTION_BYTES + 1);
        assert!(matches!(
            redactions.register(std::slice::from_ref(&oversized), &mut logs),
            Err(Error::ResourceLimit(_))
        ));
        assert!(logs.entries.is_empty());

        let writes = Arc::new(Mutex::new(Vec::new()));
        let io = FakeIo::new(writes.clone(), std::iter::empty());
        let mut runtime = EngineRuntime::new(Box::new(io), EngineDeadlines::default());
        for index in 0..MAX_RESOURCE_REDACTIONS {
            let value = format!("/resource/{index}");
            runtime
                .set_option_with_resources("Book", &value, std::slice::from_ref(&value), None, None)
                .await
                .unwrap();
        }
        let overflow = "/resource/overflow".to_string();
        assert!(matches!(
            runtime
                .set_option_with_resources(
                    "Book",
                    &overflow,
                    std::slice::from_ref(&overflow),
                    None,
                    None,
                )
                .await,
            Err(Error::ResourceLimit(_))
        ));
        assert_eq!(writes.lock().await.len(), MAX_RESOURCE_REDACTIONS);
        assert!(!runtime
            .logs
            .entries()
            .iter()
            .any(|entry| matches!(entry, EngineLog::Gui(line) if line.contains(&overflow))));
    }

    #[tokio::test]
    async fn resource_redaction_byte_budget_is_cumulative_and_deduplicated() {
        let first = "a".repeat(30_000);
        let second = "b".repeat(35_000);
        let overflow = "c".repeat(1_000);
        assert!(first.len() <= MAX_RESOURCE_REDACTION_BYTES);
        assert!(second.len() <= MAX_RESOURCE_REDACTION_BYTES);
        assert!(overflow.len() <= MAX_RESOURCE_REDACTION_BYTES);
        assert!(first.len() + second.len() <= MAX_RESOURCE_REDACTION_BYTES);
        assert!(first.len() + second.len() + overflow.len() > MAX_RESOURCE_REDACTION_BYTES);
        let echoed = format!("echo {first}");
        let (actor, writes) = EngineActor::recording_test_actor(&[&echoed]);

        actor
            .set_option_with_resources("Book", &first, std::slice::from_ref(&first))
            .await
            .unwrap();
        // A duplicate registration must not consume another 30,000 bytes;
        // otherwise the individually valid second value would be rejected.
        actor
            .set_option_with_resources("Book", &first, std::slice::from_ref(&first))
            .await
            .unwrap();
        actor
            .set_option_with_resources("Book", &second, std::slice::from_ref(&second))
            .await
            .unwrap();

        let result = actor
            .set_option_with_resources("Book", &overflow, std::slice::from_ref(&overflow))
            .await;
        assert!(matches!(result, Err(Error::ResourceLimit(_))));
        assert_eq!(writes.lock().await.len(), 3);

        // Both prior values remain known after the rejected registration, so
        // retained commands and a delayed engine echo stay masked.
        assert_eq!(actor.next_configuration_line().await.unwrap(), Some(echoed));
        let logs = actor.logs().await.unwrap();
        assert!(logs.iter().all(|entry| match entry {
            EngineLog::Gui(line) | EngineLog::Engine(line) => {
                !line.contains(&first) && !line.contains(&second) && !line.contains(&overflow)
            }
            EngineLog::Truncated { .. } => true,
        }));
        assert!(logs.iter().any(|entry| matches!(
            entry,
            EngineLog::Engine(line) if line == "echo [redacted]"
        )));
        actor.terminate().await.unwrap();
    }

    #[tokio::test]
    async fn overlapping_resource_redactions_are_longest_first_in_retained_and_echoed_logs() {
        let short = "/proc/self/fd/1".to_string();
        let long = "/proc/self/fd/10".to_string();
        let echoed = format!("echo {long}");
        let (actor, _) = EngineActor::recording_test_actor(&[&echoed]);

        actor
            .set_option_with_resources("Book", &short, std::slice::from_ref(&short))
            .await
            .unwrap();
        actor
            .set_option_with_resources("Book", &long, std::slice::from_ref(&long))
            .await
            .unwrap();
        assert_eq!(actor.next_configuration_line().await.unwrap(), Some(echoed));

        let logs = actor.logs().await.unwrap();
        assert!(logs.iter().any(|entry| matches!(
            entry,
            EngineLog::Gui(line) if line == "setoption name Book value [redacted]\n"
        )));
        assert!(logs.iter().any(|entry| matches!(
            entry,
            EngineLog::Engine(line) if line == "echo [redacted]"
        )));
        assert!(logs.iter().all(|entry| match entry {
            EngineLog::Gui(line) | EngineLog::Engine(line) => {
                !line.contains(&short) && !line.contains(&long)
            }
            EngineLog::Truncated { .. } => true,
        }));
        actor.terminate().await.unwrap();
    }

    #[tokio::test]
    async fn exact_generation_cleanup_cannot_remove_replacement() {
        let supervisor = EngineSupervisor::default();
        let key = EngineKey::new("a".into(), "engine".into()).unwrap();
        let (first, _) = actor(&[]);
        let first = supervisor.replace(key.clone(), first).await.unwrap();
        let (second, _) = actor(&[]);
        let second = supervisor.replace(key.clone(), second).await.unwrap();
        supervisor
            .terminate_exact(&key, first.generation)
            .await
            .unwrap();
        assert_eq!(
            supervisor.get_exact(&key).unwrap().generation,
            second.generation
        );
    }

    #[tokio::test]
    async fn stop_generation_unscoped_stops_actor_and_cancels_pending_admission() {
        let supervisor = EngineSupervisor::default();
        let key = EngineKey::new("tab".into(), "engine".into()).unwrap();
        let ((actor, _), terminated) = actor_with(&[], false, None);
        let live = supervisor.replace(key.clone(), actor).await.unwrap();
        let executable = path_ref("test-engine");
        let pending_generation = supervisor
            .prepare_engine_search(key.clone(), "engine".into(), executable)
            .await
            .unwrap()
            .parse::<u64>()
            .unwrap();
        let pending = supervisor.admissions.get(&key).unwrap().clone();

        supervisor.stop_generation(&key, None).await.unwrap();

        assert_eq!(terminated.load(AtomicOrdering::SeqCst), 1);
        assert!(live.cancelled.load(AtomicOrdering::SeqCst));
        assert_eq!(pending.generation, pending_generation);
        assert!(pending.cancelled.load(AtomicOrdering::SeqCst));
        assert!(!supervisor.admissions.contains_key(&key));
        assert!(supervisor.get_exact(&key).is_none());
    }

    #[tokio::test]
    async fn stop_generation_exact_actor_leaves_different_pending_admission() {
        let supervisor = EngineSupervisor::default();
        let key = EngineKey::new("tab".into(), "engine".into()).unwrap();
        let ((actor, _), terminated) = actor_with(&[], false, None);
        let live = supervisor.replace(key.clone(), actor).await.unwrap();
        let pending_generation = supervisor
            .prepare_engine_search(key.clone(), "engine".into(), path_ref("test-engine"))
            .await
            .unwrap()
            .parse::<u64>()
            .unwrap();
        let pending = supervisor.admissions.get(&key).unwrap().clone();

        supervisor
            .stop_generation(&key, Some(live.generation))
            .await
            .unwrap();

        assert_eq!(terminated.load(AtomicOrdering::SeqCst), 1);
        assert!(supervisor.get_exact(&key).is_none());
        assert_eq!(pending.generation, pending_generation);
        assert!(!pending.cancelled.load(AtomicOrdering::SeqCst));
        assert!(supervisor.admissions.contains_key(&key));

        supervisor
            .stop_generation(&key, Some(pending_generation))
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn stop_generation_exact_pending_admission_preserves_live_actor() {
        let supervisor = EngineSupervisor::default();
        let key = EngineKey::new("tab".into(), "engine".into()).unwrap();
        let ((actor, _), terminated) = actor_with(&[], false, None);
        let live = supervisor.replace(key.clone(), actor).await.unwrap();
        let pending_generation = supervisor
            .prepare_engine_search(key.clone(), "engine".into(), path_ref("test-engine"))
            .await
            .unwrap()
            .parse::<u64>()
            .unwrap();
        let pending = supervisor.admissions.get(&key).unwrap().clone();

        supervisor
            .stop_generation(&key, Some(pending_generation))
            .await
            .unwrap();

        assert_eq!(terminated.load(AtomicOrdering::SeqCst), 0);
        assert_eq!(
            supervisor.get_exact(&key).unwrap().generation,
            live.generation
        );
        assert!(pending.cancelled.load(AtomicOrdering::SeqCst));
        assert!(!supervisor.admissions.contains_key(&key));

        supervisor
            .stop_generation(&key, Some(live.generation))
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn stop_generation_exact_cancels_admission_added_while_registration_waits() {
        let supervisor = Arc::new(EngineSupervisor::default());
        let key = EngineKey::new("tab".into(), "engine".into()).unwrap();
        let expected_generation = supervisor.next_generation.load(AtomicOrdering::SeqCst) + 1;
        let registration = supervisor.registration.lock().await;
        let stop = tokio::spawn({
            let supervisor = supervisor.clone();
            let key = key.clone();
            async move {
                supervisor
                    .stop_generation(&key, Some(expected_generation))
                    .await
            }
        });
        tokio::task::yield_now().await;

        let admission = tokio::spawn({
            let supervisor = supervisor.clone();
            let key = key.clone();
            async move {
                supervisor
                    .admit(key, "engine".into(), path_ref("engine-path"), true)
                    .await
            }
        });
        while !supervisor
            .admissions
            .get(&key)
            .is_some_and(|entry| entry.generation == expected_generation)
        {
            tokio::task::yield_now().await;
        }
        let pending = supervisor.admissions.get(&key).unwrap().clone();
        drop(registration);

        stop.await.unwrap().unwrap();
        match admission.await.unwrap() {
            Ok(lease) => assert!(lease.cancel_error().is_some()),
            Err(Error::Cancellation) => {}
            Err(error) => panic!("exact stop returned an unexpected admission error: {error}"),
        }
        assert!(pending.cancelled.load(AtomicOrdering::SeqCst));
        assert!(!supervisor.admissions.contains_key(&key));
    }

    #[tokio::test]
    async fn broad_stop_snapshots_empty_and_never_targets_a_later_actor() {
        let supervisor = Arc::new(EngineSupervisor::default());
        let key = EngineKey::new("tab".into(), "engine".into()).unwrap();
        supervisor.stop_generation(&key, None).await.unwrap();

        let ((actor, _), terminated) = actor_with(&[], false, None);
        let replacement = supervisor.replace(key.clone(), actor).await.unwrap();
        assert_eq!(terminated.load(AtomicOrdering::SeqCst), 0);
        assert_eq!(
            supervisor.get_exact(&key).unwrap().generation,
            replacement.generation
        );
        supervisor.terminate_all().await.unwrap();
    }

    #[tokio::test]
    async fn stop_generation_unscoped_preserves_replacement_after_target_capture() {
        use std::future::Future;

        let supervisor = Arc::new(EngineSupervisor::default());
        let key = EngineKey::new("tab".into(), "engine".into()).unwrap();
        let (first, _) = actor(&[]);
        supervisor.replace(key.clone(), first).await.unwrap();
        let lifecycle = supervisor.lifecycle_lease(&key);
        let transition = lifecycle.lock().await;
        let registration = supervisor.registration.lock().await;
        let mut stop = std::pin::pin!(supervisor.stop_generation(&key, None));
        let mut context = std::task::Context::from_waker(std::task::Waker::noop());
        assert!(matches!(
            stop.as_mut().poll(&mut context),
            std::task::Poll::Pending
        ));

        let ((replacement_actor, _), replacement_terminated) = actor_with(&[], false, None);
        let replacement_generation = supervisor.allocate_generation().unwrap();
        supervisor.actors.insert(
            key.clone(),
            SupervisedEngine::new(
                replacement_generation,
                "engine".into(),
                path_ref("replacement-path"),
                Arc::new(replacement_actor),
                Arc::new(AtomicBool::new(false)),
            ),
        );
        drop(registration);
        drop(transition);

        stop.await.unwrap();
        assert_eq!(replacement_terminated.load(AtomicOrdering::SeqCst), 0);
        assert_eq!(
            supervisor.get_exact(&key).unwrap().generation,
            replacement_generation
        );
        supervisor.terminate_all().await.unwrap();
    }

    #[tokio::test]
    async fn generation_stop_waiting_on_lifecycle_cannot_stop_replacement() {
        let supervisor = Arc::new(EngineSupervisor::default());
        let key = EngineKey::new("tab".into(), "engine".into()).unwrap();
        let (first_actor, _) = actor(&[]);
        let first = supervisor.replace(key.clone(), first_actor).await.unwrap();
        let lifecycle = supervisor.lifecycle_lease(&key);
        let transition = lifecycle.lock().await;
        let registration = supervisor.registration.lock().await;
        let stop = tokio::spawn({
            let supervisor = supervisor.clone();
            let key = key.clone();
            async move {
                supervisor
                    .stop_generation(&key, Some(first.generation))
                    .await
            }
        });
        tokio::task::yield_now().await;

        let ((replacement_actor, _), replacement_terminated) = actor_with(&[], false, None);
        let replacement_generation = supervisor.allocate_generation().unwrap();
        supervisor.actors.insert(
            key.clone(),
            SupervisedEngine::new(
                replacement_generation,
                "engine".into(),
                path_ref("replacement-path"),
                Arc::new(replacement_actor),
                Arc::new(AtomicBool::new(false)),
            ),
        );
        drop(registration);
        drop(transition);

        stop.await.unwrap().unwrap();
        assert_eq!(replacement_terminated.load(AtomicOrdering::SeqCst), 0);
        assert_eq!(
            supervisor.get_exact(&key).unwrap().generation,
            replacement_generation
        );
        supervisor.terminate_all().await.unwrap();
    }

    #[tokio::test]
    async fn exact_stop_reaps_an_idle_published_actor_before_it_can_search() {
        let supervisor = Arc::new(EngineSupervisor::default());
        let key = EngineKey::new("tab".into(), "engine".into()).unwrap();
        let ((actor, _), terminated) = actor_with(&[], false, None);
        let supervised = supervisor.replace(key.clone(), actor).await.unwrap();

        supervisor
            .stop_generation(&key, Some(supervised.generation))
            .await
            .unwrap();

        assert!(supervised.cancelled.load(AtomicOrdering::SeqCst));
        assert_eq!(terminated.load(AtomicOrdering::SeqCst), 1);
        assert!(supervisor.get_exact(&key).is_none());
    }

    #[tokio::test]
    async fn consume_cannot_overwrite_a_newer_admission_while_registration_waits() {
        let supervisor = Arc::new(EngineSupervisor::default());
        let key = EngineKey::new("tab".into(), "engine".into()).unwrap();
        let executable = path_ref("engine-path");
        let first = supervisor
            .prepare_engine_search(key.clone(), "engine".into(), executable.clone())
            .await
            .unwrap();
        let registration = supervisor.registration.lock().await;
        let consumed_generation = first.clone();
        let consume = tokio::spawn({
            let supervisor = supervisor.clone();
            let key = key.clone();
            let executable = executable.clone();
            async move {
                supervisor
                    .consume_engine_search(key, "engine".into(), executable, &consumed_generation)
                    .await
            }
        });
        tokio::task::yield_now().await;
        let newer = tokio::spawn({
            let supervisor = supervisor.clone();
            let key = key.clone();
            let executable = executable.clone();
            async move {
                supervisor
                    .prepare_engine_search(key, "engine".into(), executable)
                    .await
            }
        });
        while supervisor
            .admissions
            .get(&key)
            .is_some_and(|entry| entry.generation.to_string() == first)
        {
            tokio::task::yield_now().await;
        }
        drop(registration);

        assert!(matches!(consume.await.unwrap(), Err(Error::Conflict(_))));
        let newer = newer.await.unwrap().unwrap();
        assert_eq!(
            supervisor
                .admissions
                .get(&key)
                .unwrap()
                .generation
                .to_string(),
            newer
        );
    }

    #[tokio::test]
    async fn publication_cannot_overwrite_a_newer_admission() {
        let supervisor = Arc::new(EngineSupervisor::default());
        let key = EngineKey::new("tab".into(), "engine".into()).unwrap();
        let executable = path_ref("engine-path");
        let first = supervisor
            .prepare_engine_search(key.clone(), "engine".into(), executable.clone())
            .await
            .unwrap();
        let admission = supervisor
            .consume_engine_search(key.clone(), "engine".into(), executable.clone(), &first)
            .await
            .unwrap();
        let registration = supervisor.registration.lock().await;
        let ((actor, _), terminated) = actor_with(&[], false, None);
        let publish = tokio::spawn({
            let supervisor = supervisor.clone();
            let key = key.clone();
            async move {
                supervisor
                    .publish_admitted(
                        key.clone(),
                        supervisor.track_pending_actor(key, Arc::new(actor), &admission),
                        admission,
                    )
                    .await
            }
        });
        tokio::task::yield_now().await;
        let newer = tokio::spawn({
            let supervisor = supervisor.clone();
            let key = key.clone();
            let executable = executable.clone();
            async move {
                supervisor
                    .prepare_engine_search(key, "engine".into(), executable)
                    .await
            }
        });
        while supervisor
            .admissions
            .get(&key)
            .is_some_and(|entry| entry.generation.to_string() == first)
        {
            tokio::task::yield_now().await;
        }
        drop(registration);

        assert!(matches!(publish.await.unwrap(), Err(Error::Cancellation)));
        assert_eq!(terminated.load(AtomicOrdering::SeqCst), 1);
        let newer = newer.await.unwrap().unwrap();
        assert_eq!(
            supervisor
                .admissions
                .get(&key)
                .unwrap()
                .generation
                .to_string(),
            newer
        );
        assert!(supervisor.get_exact(&key).is_none());
    }

    #[tokio::test]
    async fn prepared_searches_reject_stale_mismatched_and_replayed_generations() {
        let supervisor = Arc::new(EngineSupervisor::default());
        let key = EngineKey::new("tab".into(), "engine".into()).unwrap();
        let executable = path_ref("engine-path");
        let stale = supervisor
            .prepare_engine_search(key.clone(), "engine".into(), executable.clone())
            .await
            .unwrap();
        let current = supervisor
            .prepare_engine_search(key.clone(), "engine".into(), executable.clone())
            .await
            .unwrap();

        assert!(matches!(
            supervisor
                .consume_engine_search(key.clone(), "engine".into(), executable.clone(), &stale,)
                .await,
            Err(Error::Conflict(_))
        ));
        assert!(matches!(
            supervisor
                .consume_engine_search(
                    key.clone(),
                    "other".into(),
                    executable.clone(),
                    &current,
                )
                .await,
            Err(Error::Conflict(message)) if message.contains("does not match")
        ));
        let lease = supervisor
            .consume_engine_search(key.clone(), "engine".into(), executable, &current)
            .await
            .unwrap();
        drop(lease);
        assert!(matches!(
            supervisor
                .consume_engine_search(key, "engine".into(), path_ref("engine-path"), &current,)
                .await,
            Err(Error::Conflict(_))
        ));
        assert!(supervisor.admissions.is_empty());
    }

    #[tokio::test]
    async fn generation_stop_cancels_pending_reservation_before_start() {
        let supervisor = EngineSupervisor::default();
        let key = EngineKey::new("tab".into(), "engine".into()).unwrap();
        let executable = path_ref("engine-path");
        let generation = supervisor
            .prepare_engine_search(key.clone(), "engine".into(), executable.clone())
            .await
            .unwrap();

        supervisor
            .stop_generation(&key, Some(generation.parse().unwrap()))
            .await
            .unwrap();

        assert!(matches!(
            supervisor
                .consume_engine_search(key.clone(), "engine".into(), executable, &generation)
                .await,
            Err(Error::Conflict(_))
        ));
        assert!(supervisor.admissions.is_empty());
        assert!(supervisor.get_exact(&key).is_none());
    }

    #[tokio::test]
    async fn generation_exhaustion_allocates_last_value_once_without_retaining_an_overflow() {
        let supervisor = EngineSupervisor::default();
        supervisor
            .next_generation
            .store(u64::MAX - 1, Ordering::SeqCst);
        let last_key = EngineKey::new("last-generation".into(), "engine".into()).unwrap();
        let overflow_key = EngineKey::new("overflow-generation".into(), "engine".into()).unwrap();
        let executable = path_ref("engine-path");

        let last = supervisor
            .prepare_engine_search(last_key.clone(), "engine".into(), executable.clone())
            .await
            .unwrap();
        assert_eq!(last, u64::MAX.to_string());
        assert!(matches!(
            supervisor
                .prepare_engine_search(overflow_key.clone(), "engine".into(), executable)
                .await,
            Err(Error::ResourceLimit(message)) if message == "engine generation exhausted"
        ));
        assert_eq!(supervisor.next_generation.load(Ordering::SeqCst), u64::MAX);
        assert!(supervisor.admissions.contains_key(&last_key));
        assert!(!supervisor.admissions.contains_key(&overflow_key));
        assert_eq!(supervisor.admissions.len(), 1);
    }

    #[test]
    fn dropping_replaced_admission_cancels_its_arc_without_removing_the_replacement() {
        let admissions = Arc::new(DashMap::new());
        let key = EngineKey::new("tab".into(), "engine".into()).unwrap();
        let old_cancelled = Arc::new(AtomicBool::new(false));
        let old = EngineAdmission {
            generation: 1,
            engine_id: "engine".into(),
            executable: path_ref("old"),
            cancelled: old_cancelled.clone(),
            cancellation_reason: Arc::default(),
            prepared: false,
        };
        let lease = AdmissionLease {
            admissions: admissions.clone(),
            key: key.clone(),
            admission: old,
            operation_cancellation: None,
            disarmed: false,
        };
        admissions.insert(
            key.clone(),
            EngineAdmission {
                generation: 2,
                engine_id: "engine".into(),
                executable: path_ref("new"),
                cancelled: Arc::new(AtomicBool::new(false)),
                cancellation_reason: Arc::default(),
                prepared: false,
            },
        );

        drop(lease);

        assert!(old_cancelled.load(Ordering::SeqCst));
        assert_eq!(admissions.get(&key).unwrap().generation, 2);
    }

    #[tokio::test]
    async fn prepared_search_capacity_refuses_without_evicting_and_reclaims() {
        let supervisor = Arc::new(EngineSupervisor::default());
        let executable = path_ref("engine-path");
        let mut reservations = Vec::new();
        for index in 0..MAX_PENDING_ENGINE_SEARCHES {
            let key = EngineKey::new(format!("tab-{index}"), "engine".into()).unwrap();
            let generation = supervisor
                .prepare_engine_search(key.clone(), "engine".into(), executable.clone())
                .await
                .unwrap();
            reservations.push((key, generation));
        }
        let overflow = EngineKey::new("overflow".into(), "engine".into()).unwrap();
        assert!(matches!(
            supervisor
                .prepare_engine_search(overflow.clone(), "engine".into(), executable.clone())
                .await,
            Err(Error::ResourceLimit(_))
        ));

        let (first_key, first_generation) = reservations.remove(0);
        drop(
            supervisor
                .consume_engine_search(
                    first_key,
                    "engine".into(),
                    executable.clone(),
                    &first_generation,
                )
                .await
                .unwrap(),
        );
        assert!(supervisor
            .prepare_engine_search(overflow, "engine".into(), executable)
            .await
            .is_ok());
    }

    #[tokio::test]
    async fn tab_close_cancels_consumed_admission_and_reaps_late_actor() {
        let supervisor = Arc::new(EngineSupervisor::default());
        let key = EngineKey::new("closing".into(), "engine".into()).unwrap();
        let other_key = EngineKey::new("other".into(), "engine".into()).unwrap();
        let executable = path_ref("engine-path");
        let generation = supervisor
            .prepare_engine_search(key.clone(), "engine".into(), executable.clone())
            .await
            .unwrap();
        let admission = supervisor
            .consume_engine_search(
                key.clone(),
                "engine".into(),
                executable.clone(),
                &generation,
            )
            .await
            .unwrap();
        let other_generation = supervisor
            .prepare_engine_search(other_key.clone(), "engine".into(), executable.clone())
            .await
            .unwrap();
        supervisor.terminate_tab("closing").await.unwrap();
        let ((actor, _), terminated) = actor_with(&[], false, None);

        assert!(matches!(
            supervisor
                .publish_admitted(
                    key.clone(),
                    supervisor.track_pending_actor(key.clone(), Arc::new(actor), &admission),
                    admission
                )
                .await,
            Err(Error::Cancellation)
        ));
        assert_eq!(terminated.load(AtomicOrdering::SeqCst), 1);
        assert!(supervisor.get_exact(&key).is_none());
        assert!(supervisor
            .consume_engine_search(other_key, "engine".into(), executable, &other_generation)
            .await
            .is_ok());
    }

    #[tokio::test]
    async fn operation_cancellation_during_initialization_reaps_only_its_exact_actor() {
        let supervisor = Arc::new(EngineSupervisor::default());
        let key = EngineKey::new("analysis".into(), "owned".into()).unwrap();
        let other_key = EngineKey::new("analysis".into(), "other".into()).unwrap();
        let operation = CancellationToken::new();
        let admission = supervisor
            .admit_for_operation(
                key.clone(),
                "owned-engine".into(),
                path_ref("owned-path"),
                operation.clone(),
            )
            .await
            .unwrap();
        let ((actor, _), terminated) = actor_with(&[], false, None);
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let initializing = tokio::spawn({
            let supervisor = supervisor.clone();
            let key = key.clone();
            async move {
                initialize_admitted_actor(
                    supervisor.clone(),
                    key.clone(),
                    Arc::new(actor),
                    admission,
                    move |_| async move {
                        let _ = entered_tx.send(());
                        std::future::pending::<Result<(), Error>>().await
                    },
                )
                .await
                .map(|(_, mut guard, ())| guard.disarm())
            }
        });
        tokio::time::timeout(Duration::from_secs(1), entered_rx)
            .await
            .unwrap()
            .unwrap();

        let other_operation = CancellationToken::new();
        let other_admission = supervisor
            .admit_for_operation(
                other_key.clone(),
                "other-engine".into(),
                path_ref("other-path"),
                other_operation.clone(),
            )
            .await
            .unwrap();
        operation.cancel();

        assert!(matches!(
            tokio::time::timeout(Duration::from_secs(1), initializing)
                .await
                .unwrap()
                .unwrap(),
            Err(Error::Cancellation)
        ));
        assert_eq!(terminated.load(AtomicOrdering::SeqCst), 1);
        assert!(supervisor.get_exact(&key).is_none());
        assert!(!other_operation.is_cancelled());
        assert!(other_admission.cancel_error().is_none());
        assert!(supervisor.admissions.contains_key(&other_key));
    }

    #[tokio::test]
    async fn shutdown_cancels_pending_search_and_refuses_publication() {
        let supervisor = Arc::new(EngineSupervisor::default());
        let key = EngineKey::new("tab".into(), "engine".into()).unwrap();
        let executable = path_ref("engine-path");
        let generation = supervisor
            .prepare_engine_search(key.clone(), "engine".into(), executable.clone())
            .await
            .unwrap();

        supervisor.terminate_all().await.unwrap();

        assert!(matches!(
            supervisor
                .consume_engine_search(key, "engine".into(), executable, &generation)
                .await,
            Err(Error::Conflict(_))
        ));
        assert!(supervisor.admissions.is_empty());
    }

    #[tokio::test]
    async fn shutdown_rejection_preserves_actor_cleanup_failure() {
        let supervisor = EngineSupervisor::default();
        supervisor.terminate_all().await.unwrap();
        let key = EngineKey::new("shutdown".into(), "cleanup-fails".into()).unwrap();
        let actor = EngineActor::new(Box::new(TerminateErrorIo), EngineDeadlines::default());

        assert!(matches!(
            supervisor.replace(key, actor).await,
            Err(Error::OperationAndCleanup { .. })
        ));
    }

    #[tokio::test]
    async fn replacing_a_live_actor_cancels_the_previous_generation() {
        let supervisor = EngineSupervisor::default();
        let key = EngineKey::new("tab".into(), "engine".into()).unwrap();
        let (old, _) = actor(&[]);
        let first = supervisor.replace(key.clone(), old).await.unwrap();
        let (replacement, _) = actor(&[]);
        let second = supervisor.replace(key.clone(), replacement).await.unwrap();

        assert_ne!(first.generation, second.generation);
        assert!(first.cancelled.load(Ordering::SeqCst));
        let published = first
            .try_publish(|| -> Result<(), Error> {
                panic!("replaced generation must not publish");
            })
            .unwrap();
        assert!(!published);
        assert!(!second.cancelled.load(Ordering::SeqCst));
        supervisor
            .terminate_exact(&key, second.generation)
            .await
            .unwrap();
    }

    #[test]
    fn cancel_and_publish_share_the_publication_lock() {
        let source = include_str!("process.rs");
        let production = source
            .split_once("mod tests {")
            .map(|(prefix, _)| prefix)
            .expect("test module should exist");
        let barrier = production
            .split_once("impl PublicationBarrier {")
            .unwrap()
            .1;
        for function in ["pub fn mark_cancelled(", "pub fn try_publish<E>("] {
            let body = crate::infra::blocking::source_scan::body_at_indent(barrier, function);
            assert!(
                body.contains(".publish") && body.contains(".lock()"),
                "{function} must take the publication lock"
            );
            assert!(body.find(".lock()").unwrap() < body.find("self.cancelled").unwrap());
        }
    }

    #[tokio::test]
    async fn terminate_exact_marks_the_generation_cancelled_before_reaping() {
        let supervisor = EngineSupervisor::default();
        let key = EngineKey::new("tab".into(), "engine".into()).unwrap();
        let (actor, _) = actor(&[]);
        let supervised = supervisor.replace(key.clone(), actor).await.unwrap();

        supervisor
            .terminate_exact(&key, supervised.generation)
            .await
            .unwrap();

        assert!(supervised.cancelled.load(Ordering::SeqCst));
        assert!(supervisor.get_exact(&key).is_none());
        let published = supervised
            .try_publish(|| -> Result<(), Error> {
                panic!("cancelled generation must not publish");
            })
            .unwrap();
        assert!(!published);
    }

    #[tokio::test]
    async fn try_publish_skips_after_mark_cancelled_without_emitting() {
        let (actor, _) = actor(&[]);
        let actor = Arc::new(actor);
        let supervised = SupervisedEngine::new(
            7,
            "engine".into(),
            path_ref("engine-path"),
            actor.clone(),
            Arc::new(AtomicBool::new(false)),
        );
        supervised.mark_cancelled();
        let published = supervised
            .try_publish(|| -> Result<(), Error> {
                panic!("cancelled generation must not publish");
            })
            .unwrap();
        assert!(!published);
        assert!(supervised.cancelled.load(Ordering::SeqCst));
        actor.terminate().await.unwrap();
    }

    #[tokio::test]
    async fn terminate_exact_removes_entry_when_termination_reports_an_error() {
        let supervisor = EngineSupervisor::default();
        let key = EngineKey::new("tab".into(), "engine".into()).unwrap();
        let actor = EngineActor::new(Box::new(TerminateErrorIo), EngineDeadlines::default());
        let supervised = supervisor.replace(key.clone(), actor).await.unwrap();

        assert!(supervisor
            .terminate_exact(&key, supervised.generation)
            .await
            .is_err());
        assert!(supervisor.get_exact(&key).is_none());
        assert_eq!(supervisor.lifecycle.len(), 0);
    }

    #[tokio::test]
    async fn lifecycle_leases_are_reclaimed_after_distinct_missing_engine_operations() {
        let supervisor = EngineSupervisor::default();
        for index in 0..2_000 {
            let key = EngineKey::new(format!("tab-{index}"), format!("engine-{index}")).unwrap();
            supervisor.terminate_exact(&key, 1).await.unwrap();
            supervisor.stop_exact(&key).await.unwrap();
        }
        assert_eq!(supervisor.lifecycle.len(), 0);
    }

    #[tokio::test]
    async fn terminate_all_reaps_every_registered_actor() {
        let supervisor = EngineSupervisor::default();
        let mut registered = Vec::new();
        for (tab, engine) in [("first", "a"), ("second", "b")] {
            let key = EngineKey::new(tab.into(), engine.into()).unwrap();
            let ((actor, _), terminated) = actor_with(&[], false, None);
            supervisor.replace(key.clone(), actor).await.unwrap();
            registered.push((key, terminated));
        }

        supervisor.terminate_all().await.unwrap();

        for (key, terminated) in registered {
            assert_eq!(
                terminated.load(AtomicOrdering::SeqCst),
                1,
                "every registered actor must be terminated, not only the first"
            );
            assert!(
                supervisor.get_exact(&key).is_none(),
                "a terminated actor must leave no registry entry behind"
            );
        }
    }

    #[tokio::test]
    async fn shutdown_aggregation_preserves_types_logs_identity_and_completes_all_targets() {
        match SHUTDOWN_FAILURE_LOGS.lock() {
            Ok(mut logs) => logs.clear(),
            Err(poisoned) => poisoned.into_inner().clear(),
        }
        let supervisor = EngineSupervisor::default();
        let timeout_key = EngineKey::new("typed".into(), "timeout".into()).unwrap();
        let combined_key = EngineKey::new("typed".into(), "combined".into()).unwrap();
        let timeout_calls = Arc::new(AtomicUsize::new(0));
        let combined_calls = Arc::new(AtomicUsize::new(0));
        let timeout_actor = EngineActor::new(
            Box::new(TypedTerminateErrorIo {
                failure: TypedTerminateFailure::Timeout,
                terminate_calls: timeout_calls.clone(),
            }),
            EngineDeadlines::default(),
        );
        let combined_actor = EngineActor::new(
            Box::new(TypedTerminateErrorIo {
                failure: TypedTerminateFailure::OperationAndCleanup,
                terminate_calls: combined_calls.clone(),
            }),
            EngineDeadlines::default(),
        );
        let timeout = supervisor
            .replace(timeout_key.clone(), timeout_actor)
            .await
            .unwrap();
        let combined = supervisor
            .replace(combined_key.clone(), combined_actor)
            .await
            .unwrap();

        let failures = supervisor
            .terminate_targets(vec![
                ObservedTerminationTarget {
                    key: timeout_key.clone(),
                    generation: timeout.generation,
                    actor: Some(timeout.actor.clone()),
                    attempt: supervisor.observe_termination_locked(
                        &timeout_key,
                        timeout.generation,
                        false,
                    ),
                },
                ObservedTerminationTarget {
                    key: combined_key.clone(),
                    generation: combined.generation,
                    actor: Some(combined.actor.clone()),
                    attempt: supervisor.observe_termination_locked(
                        &combined_key,
                        combined.generation,
                        false,
                    ),
                },
            ])
            .await;
        assert_eq!(failures.len(), 2);
        assert!(matches!(
            failures[0].error.without_shared(),
            Error::EngineTimeout(_)
        ));
        assert!(matches!(
            failures[1].error.without_shared(),
            Error::OperationAndCleanup { .. }
        ));
        assert_eq!(timeout_calls.load(AtomicOrdering::SeqCst), 1);
        assert_eq!(combined_calls.load(AtomicOrdering::SeqCst), 1);
        assert!(!supervisor.owns_generation(&timeout_key, timeout.generation));
        assert!(!supervisor.owns_generation(&combined_key, combined.generation));

        assert!(matches!(
            aggregate_shutdown_failures(failures)
                .expect_err("shutdown must preserve the first failure")
                .without_shared(),
            Error::EngineTimeout(_)
        ));
        let logs = match SHUTDOWN_FAILURE_LOGS.lock() {
            Ok(logs) => logs.clone(),
            Err(poisoned) => poisoned.into_inner().clone(),
        };
        assert!(logs.iter().any(|message| {
            message.contains("typed:timeout")
                && message.contains(&format!("generation={}", timeout.generation))
                && message.contains("category=engine timeout")
        }));
        assert!(logs.iter().any(|message| {
            message.contains("typed:combined")
                && message.contains(&format!("generation={}", combined.generation))
                && message.contains("category=operation and cleanup failure")
        }));
        assert!(logs.iter().all(|message| {
            !message.contains("typed timeout sentinel")
                && !message.contains("typed primary sentinel")
                && !message.contains("typed cleanup sentinel")
        }));

        assert!(matches!(
            aggregate_shutdown_failures(vec![ActorShutdownFailure {
                key: combined_key,
                generation: combined.generation,
                error: Error::OperationAndCleanup {
                    primary: "primary".into(),
                    cleanup: "cleanup".into(),
                },
            }]),
            Err(Error::OperationAndCleanup { .. })
        ));
    }

    #[tokio::test]
    async fn failed_stop_removes_entry_and_allows_replacement() {
        let supervisor = EngineSupervisor::default();
        let key = EngineKey::new("tab".into(), "engine".into()).unwrap();
        let ((old, _), terminated) = actor_with_stop_failure(&[]);
        old.start_search(&GoMode::Depth(1)).await.unwrap();
        supervisor.replace(key.clone(), old).await.unwrap();

        assert!(supervisor.stop_exact(&key).await.is_err());
        assert_eq!(terminated.load(AtomicOrdering::SeqCst), 1);
        assert!(supervisor.get_exact(&key).is_none());

        let (replacement, _) = actor(&[]);
        supervisor.replace(key.clone(), replacement).await.unwrap();
        assert!(supervisor.get_exact(&key).is_some());
        supervisor.terminate_all().await.unwrap();
    }

    #[tokio::test]
    async fn retire_engine_reaps_matching_owners_across_tabs_only() {
        let supervisor = EngineSupervisor::default();
        let mut retired = Vec::new();
        for tab in ["first", "second"] {
            let key = EngineKey::new(tab.into(), "owner".into()).unwrap();
            let ((actor, _), terminated) = actor_with(&[], false, None);
            supervisor.replace(key.clone(), actor).await.unwrap();
            retired.push((key, terminated));
        }
        let survivor_key = EngineKey::new("first".into(), "other".into()).unwrap();
        let ((survivor, _), survivor_terminated) = actor_with(&[], false, None);
        supervisor
            .replace(survivor_key.clone(), survivor)
            .await
            .unwrap();

        supervisor.retire_engine("owner".into()).await.unwrap();

        for (key, terminated) in retired {
            assert!(supervisor.get_exact(&key).is_none());
            assert_eq!(terminated.load(AtomicOrdering::SeqCst), 1);
        }
        assert!(supervisor.get_exact(&survivor_key).is_some());
        assert_eq!(survivor_terminated.load(AtomicOrdering::SeqCst), 0);
        supervisor.terminate_all().await.unwrap();
    }

    #[tokio::test]
    async fn retire_binary_earlier_drain_preserves_readmitted_actor() {
        let supervisor = EngineSupervisor::default();
        let a = path_ref("binary-a");
        let b = path_ref("binary-b");
        let old_key = EngineKey::new("old-analysis".into(), "owner".into()).unwrap();
        let ((old_actor, _), old_terminated) = actor_with(&[], false, None);
        supervisor
            .replace_handle(
                old_key.clone(),
                Arc::new(old_actor),
                "owner".into(),
                a.clone(),
            )
            .await
            .unwrap();
        let pending = supervisor
            .admit(
                EngineKey::new("pending-analysis".into(), "owner".into()).unwrap(),
                "owner".into(),
                a.clone(),
                false,
            )
            .await
            .unwrap();

        // Stop the first drain after its admission scan and actor snapshot.
        let lifecycle = supervisor.lifecycle_lease(&old_key);
        let transition = lifecycle.lock().await;
        let retirement = supervisor.retire_engine_binary("owner".into(), a.clone(), b.clone());
        tokio::pin!(retirement);
        assert!(futures_util::poll!(retirement.as_mut()).is_pending());
        assert!(pending.cancel_error().is_some());
        assert!(supervisor.is_retired_binary("owner", &a));
        assert_eq!(old_terminated.load(AtomicOrdering::SeqCst), 0);

        supervisor
            .retire_engine_binary("owner".into(), b, a.clone())
            .await
            .unwrap();
        let new_key = EngineKey::new("new-analysis".into(), "owner".into()).unwrap();
        let ((new_actor, _), new_terminated) = actor_with(&[], false, None);
        let registered = supervisor
            .replace_handle(new_key.clone(), Arc::new(new_actor), "owner".into(), a)
            .await
            .unwrap();

        drop(transition);
        retirement.await.unwrap();
        assert_eq!(old_terminated.load(AtomicOrdering::SeqCst), 1);
        assert!(supervisor.get_exact(&old_key).is_none());
        assert_eq!(
            new_terminated.load(AtomicOrdering::SeqCst),
            0,
            "an earlier retirement drain must preserve the readmitted A actor"
        );
        assert_eq!(
            supervisor.get_exact(&new_key).unwrap().generation,
            registered.generation
        );
        assert!(registered.actor.logs().await.is_ok());
        supervisor.terminate_all().await.unwrap();
        assert_eq!(new_terminated.load(AtomicOrdering::SeqCst), 1);
    }

    #[tokio::test]
    async fn reload_completion_retirement_replay_preserves_later_a_actor_and_admission() {
        for failed in [false, true] {
            let supervisor = EngineSupervisor::default();
            let a = path_ref("completion-a");
            let b = path_ref("completion-b");
            let old_key = EngineKey::new("original".into(), "owner".into()).unwrap();
            let mut io = FakeIo::new(Arc::default(), []);
            io.termination_error = failed
                .then(|| Arc::new(Error::Conflict("retained original cleanup failure".into())));
            let old_terminated = io.terminate_calls.clone();
            let old_actor = EngineActor::new(Box::new(io), EngineDeadlines::default());
            let old = supervisor
                .replace_handle(
                    old_key.clone(),
                    Arc::new(old_actor),
                    "owner".into(),
                    a.clone(),
                )
                .await
                .unwrap();
            let captured = supervisor
                .capture_binary_retirement("owner".into(), a.clone(), b.clone(), true)
                .await
                .unwrap();
            assert_eq!(captured.targets.len(), 1);
            assert_eq!(captured.targets[0].0.generation, old.generation);
            assert_eq!(
                supervisor
                    .resume_binary_retirement(&captured)
                    .await
                    .is_err(),
                failed
            );
            assert_eq!(old_terminated.load(AtomicOrdering::SeqCst), 1);
            // A later user selection reverses admission. Recovery of the earlier workflow must only
            // observe its original generation, even after its command acknowledgement was lost.
            supervisor
                .retire_engine_binary("owner".into(), b.clone(), a.clone())
                .await
                .unwrap();
            let new_key = EngineKey::new("later-selection".into(), "owner".into()).unwrap();
            let ((new_actor, _), new_terminated) = actor_with(&[], false, None);
            let current = supervisor
                .replace_handle(
                    new_key.clone(),
                    Arc::new(new_actor),
                    "owner".into(),
                    a.clone(),
                )
                .await
                .unwrap();
            assert_eq!(
                supervisor
                    .resume_binary_retirement(&captured)
                    .await
                    .is_err(),
                failed
            );
            assert_eq!(
                supervisor
                    .resume_binary_retirement(&captured)
                    .await
                    .is_err(),
                failed
            );
            assert_eq!(old_terminated.load(AtomicOrdering::SeqCst), 1);
            assert_eq!(new_terminated.load(AtomicOrdering::SeqCst), 0);
            assert_eq!(
                supervisor.get_exact(&new_key).unwrap().generation,
                current.generation
            );
            assert!(current.actor.logs().await.is_ok());
            let admitted = supervisor
                .admit(
                    EngineKey::new("further-search".into(), "owner".into()).unwrap(),
                    "owner".into(),
                    a.clone(),
                    false,
                )
                .await
                .unwrap();
            assert!(admitted.cancel_error().is_none());
            assert!(!supervisor.is_retired_binary("owner", &a));
            assert!(supervisor.is_retired_binary("owner", &b));
            supervisor.terminate_all().await.unwrap();
        }
    }

    #[tokio::test]
    async fn retire_binary_round_trip_readmits_current_and_preserves_game_actors() {
        let supervisor = EngineSupervisor::default();
        let a = path_ref("binary-a");
        let b = path_ref("binary-b");
        let mut games = Vec::new();
        for (side, executable) in [("white", a.clone()), ("black", b.clone())] {
            let key = EngineKey::game("game-id", 42, side, "owner").unwrap();
            let ((actor, _), terminated) = actor_with(&[], false, None);
            let registered = supervisor
                .replace_handle(key.clone(), Arc::new(actor), "owner".into(), executable)
                .await
                .unwrap();
            games.push((key, registered, terminated));
        }
        supervisor
            .retire_engine_binary("other-owner".into(), a.clone(), b.clone())
            .await
            .unwrap();
        supervisor
            .retire_engine_binary("owner".into(), a.clone(), b.clone())
            .await
            .unwrap();
        supervisor
            .retire_engine_binary("owner".into(), b.clone(), a.clone())
            .await
            .unwrap();

        let key = EngineKey::new("analysis".into(), "owner".into()).unwrap();
        let admission = supervisor
            .admit(key.clone(), "owner".into(), a.clone(), false)
            .await;
        assert!(
            admission.is_ok(),
            "returning to binary A must admit analysis"
        );
        assert!(matches!(
            supervisor.admit(key, "owner".into(), b, false).await,
            Err(Error::Conflict(message)) if message == "engine binary pair is retired"
        ));
        assert!(matches!(
            supervisor
                .admit(
                    EngineKey::new("other-analysis".into(), "other-owner".into()).unwrap(),
                    "other-owner".into(),
                    a,
                    false,
                )
                .await,
            Err(Error::Conflict(message)) if message == "engine binary pair is retired"
        ));
        for (key, registered, terminated) in &games {
            assert_eq!(terminated.load(AtomicOrdering::SeqCst), 0);
            assert_eq!(
                supervisor.get_exact(key).unwrap().generation,
                registered.generation
            );
            assert!(registered.actor.logs().await.is_ok());
        }
        supervisor.terminate_all().await.unwrap();
        for (_, _, terminated) in games {
            assert_eq!(terminated.load(AtomicOrdering::SeqCst), 1);
        }
    }

    #[tokio::test]
    async fn retire_binary_same_pair_is_noop_for_actors_admissions_and_tombstones() {
        let supervisor = EngineSupervisor::default();
        let executable = path_ref("binary");
        let key = EngineKey::new("analysis".into(), "owner".into()).unwrap();
        let ((actor, _), terminated) = actor_with(&[], false, None);
        let registered = supervisor
            .replace_handle(
                key.clone(),
                Arc::new(actor),
                "owner".into(),
                executable.clone(),
            )
            .await
            .unwrap();
        let pending_key = EngineKey::new("pending".into(), "owner".into()).unwrap();
        let admission = supervisor
            .admit(pending_key, "owner".into(), executable.clone(), false)
            .await
            .unwrap();
        supervisor
            .retire_engine_binary("owner".into(), executable.clone(), executable.clone())
            .await
            .unwrap();
        assert_eq!(terminated.load(AtomicOrdering::SeqCst), 0);
        assert_eq!(
            supervisor.get_exact(&key).unwrap().generation,
            registered.generation
        );
        assert!(admission.cancel_error().is_none());
        assert!(!supervisor.is_retired_binary("owner", &executable));

        supervisor
            .retire_engine_binary("owner".into(), executable.clone(), path_ref("other"))
            .await
            .unwrap();
        supervisor
            .retire_engine_binary("owner".into(), executable.clone(), executable.clone())
            .await
            .unwrap();
        assert!(supervisor.is_retired_binary("owner", &executable));
        assert_eq!(terminated.load(AtomicOrdering::SeqCst), 1);
        assert!(admission.cancel_error().is_some());
        supervisor.terminate_all().await.unwrap();
    }

    #[test]
    fn retired_set_readmission_removes_eviction_order_before_reinsertion() {
        let mut retired = RetiredSet::new(2);
        retired.insert("a");
        retired.insert("b");
        retired.remove(&"a");
        retired.insert("a");
        retired.insert("c");
        assert!(retired.entries.contains("a"));
        assert!(!retired.entries.contains("b"));
        assert!(retired.entries.contains("c"));
        assert_eq!(retired.order.len(), 2);
    }

    #[tokio::test]
    async fn retire_binary_pair_preserves_live_same_owner_new_binary() {
        let supervisor = EngineSupervisor::default();
        let old = path_ref("old-binary");
        let new = path_ref("new-binary");
        let old_key = EngineKey::new("old-analysis".into(), "owner".into()).unwrap();
        let new_key = EngineKey::new("new-analysis".into(), "owner".into()).unwrap();
        let ((old_actor, _), old_terminated) = actor_with(&[], false, None);
        let ((new_actor, _), new_terminated) = actor_with(&[], false, None);
        supervisor
            .replace_handle(
                old_key.clone(),
                Arc::new(old_actor),
                "owner".into(),
                old.clone(),
            )
            .await
            .unwrap();
        let registered = supervisor
            .replace_handle(
                new_key.clone(),
                Arc::new(new_actor),
                "owner".into(),
                new.clone(),
            )
            .await
            .unwrap();

        supervisor
            .retire_engine_binary("owner".into(), old, new.clone())
            .await
            .unwrap();

        assert_eq!(old_terminated.load(AtomicOrdering::SeqCst), 1);
        assert!(supervisor.get_exact(&old_key).is_none());
        assert_eq!(new_terminated.load(AtomicOrdering::SeqCst), 0);
        assert_eq!(
            supervisor.get_exact(&new_key).unwrap().generation,
            registered.generation
        );
        assert!(registered.actor.logs().await.is_ok());
        let fresh_key = EngineKey::new("fresh-analysis".into(), "owner".into()).unwrap();
        assert!(supervisor
            .admit(fresh_key, "owner".into(), new, false)
            .await
            .is_ok());
        supervisor.terminate_all().await.unwrap();
        assert_eq!(new_terminated.load(AtomicOrdering::SeqCst), 1);
    }

    #[tokio::test]
    async fn retire_binary_pair_tombstone_preserves_id_and_duplicate_and_bounds_retention() {
        let supervisor = EngineSupervisor::default();
        let old = path_ref("old-binary");
        let key = EngineKey::new("analysis".into(), "operation".into()).unwrap();
        let ((actor, _), terminated) = actor_with(&[], false, None);
        supervisor
            .replace_handle(key.clone(), Arc::new(actor), "owner".into(), old.clone())
            .await
            .unwrap();
        supervisor
            .retire_engine_binary("owner".into(), old.clone(), path_ref("new-binary"))
            .await
            .unwrap();
        assert_eq!(terminated.load(AtomicOrdering::SeqCst), 1);
        assert!(supervisor.get_exact(&key).is_none());
        let ((actor, _), _) = actor_with(&[], false, None);
        assert!(supervisor
            .replace_handle(key.clone(), Arc::new(actor), "owner".into(), old.clone())
            .await
            .is_err());
        for (id, executable) in [
            ("owner", path_ref("new-binary")),
            ("duplicate", old.clone()),
        ] {
            let ((actor, _), _) = actor_with(&[], false, None);
            supervisor
                .replace_handle(key.clone(), Arc::new(actor), id.into(), executable)
                .await
                .unwrap();
        }
        for index in 0..=MAX_RETIRED_ENGINE_BINARIES {
            supervisor
                .retire_engine_binary(
                    format!("bounded-{index}"),
                    old.clone(),
                    path_ref("new-binary"),
                )
                .await
                .unwrap();
        }
        assert!(!supervisor.is_retired_binary("bounded-0", &old));
        assert!(
            supervisor.is_retired_binary(&format!("bounded-{MAX_RETIRED_ENGINE_BINARIES}"), &old)
        );
        supervisor.terminate_all().await.unwrap();
    }

    #[tokio::test]
    async fn retire_binary_race_cancels_in_flight_admission_and_refuses_late_publication() {
        let supervisor = Arc::new(EngineSupervisor::default());
        let key = EngineKey::new("tab".into(), "owner".into()).unwrap();
        let old = path_ref("old-binary");
        let registration = supervisor.registration.lock().await;
        let retirement =
            supervisor.retire_engine_binary("owner".into(), old.clone(), path_ref("new-binary"));
        tokio::pin!(retirement);
        // Queue retirement first so FIFO registration captures the later admission before
        // replacement can publish, without waiting for a tombstone behind our own guard.
        assert!(futures_util::poll!(retirement.as_mut()).is_pending());
        let ((actor, _), terminated) = actor_with(&[], false, None);
        let replacement = tokio::spawn({
            let supervisor = supervisor.clone();
            let key = key.clone();
            let old = old.clone();
            async move {
                supervisor
                    .replace_handle(key, Arc::new(actor), "owner".into(), old)
                    .await
            }
        });
        timeout(Duration::from_secs(2), async {
            while !supervisor.admissions.contains_key(&key) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        drop(registration);
        retirement.await.unwrap();
        assert!(supervisor.is_retired_binary("owner", &old));
        assert!(replacement.await.unwrap().is_err());
        assert_eq!(terminated.load(AtomicOrdering::SeqCst), 1);
        assert!(supervisor.get_exact(&key).is_none());
        assert!(supervisor
            .admit(key.clone(), "owner".into(), old, false)
            .await
            .is_err());
        // A stale pair cannot publish, but this identity can immediately use its new binary.
        assert!(supervisor
            .admit(key, "owner".into(), path_ref("new-binary"), false)
            .await
            .is_ok());
    }

    #[test]
    fn native_game_constructor_produces_game_engine_key() {
        let key = EngineKey::game("game-id", 42, "white", "owner").unwrap();
        assert_eq!(key.tab, "game:game-id:42:white");
        assert_eq!(key.engine, "owner");
        assert!(is_game_engine_key(&key));
        let analysis_key = EngineKey::new("analysis".into(), "owner".into()).unwrap();
        assert!(!is_game_engine_key(&analysis_key));
    }

    #[tokio::test]
    async fn retire_binary_game_actor_survives_answers_and_keeps_own_key_admission() {
        let supervisor = EngineSupervisor::default();
        let key = crate::game::game_side_engine_key("game-id", 42, "white", "owner").unwrap();
        let old = path_ref("old-binary");
        let ((actor, _), terminated) = actor_with(&[], false, None);
        let registered = supervisor
            .replace_handle(key.clone(), Arc::new(actor), "owner".into(), old.clone())
            .await
            .unwrap();
        supervisor
            .retire_engine_binary("owner".into(), old.clone(), path_ref("new-binary"))
            .await
            .unwrap();
        assert_eq!(terminated.load(AtomicOrdering::SeqCst), 0);
        assert!(supervisor.get_exact(&key).is_some());
        assert!(registered.actor.logs().await.is_ok());
        assert!(supervisor
            .admit(key, "owner".into(), old, false)
            .await
            .is_ok());
        supervisor.terminate_all().await.unwrap();
        assert_eq!(terminated.load(AtomicOrdering::SeqCst), 1);
    }

    #[tokio::test]
    async fn retire_engine_matches_analysis_owner_not_operation_key() {
        let supervisor = EngineSupervisor::default();
        let key = EngineKey::new("analysis".into(), "operation".into()).unwrap();
        let ((actor, _), terminated) = actor_with(&[], false, None);
        supervisor
            .replace_handle(
                key.clone(),
                Arc::new(actor),
                "engine-E".into(),
                PathRef {
                    id: "engine-path".into(),
                },
            )
            .await
            .unwrap();

        supervisor.retire_engine("other".into()).await.unwrap();
        assert!(supervisor.get_exact(&key).is_some());
        supervisor.retire_engine("engine-E".into()).await.unwrap();
        assert!(supervisor.get_exact(&key).is_none());
        assert_eq!(terminated.load(AtomicOrdering::SeqCst), 1);
    }

    #[tokio::test]
    async fn application_id_retirement_refuses_game_admission_with_typed_reason() {
        let supervisor = EngineSupervisor::default();
        supervisor
            .retire_engine("retired-game".into())
            .await
            .unwrap();
        let key = EngineKey::game("retired-game", 1, "white", "retired-game").unwrap();
        assert!(matches!(
            supervisor
                .admit_for_launch(key, "retired-game".into(), path_ref("image"))
                .await,
            Err(Error::EngineRetired)
        ));
        assert!(supervisor.admissions.is_empty());
        assert_eq!(supervisor.spawn_attempts.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn application_id_retirement_reaches_in_flight_game_launch_resolution() {
        let supervisor = EngineSupervisor::default();
        let key = EngineKey::game("retiring-game", 1, "white", "retiring-game").unwrap();
        let executable = path_ref("image");
        let admission = supervisor
            .admit_for_launch(key, "retiring-game".into(), executable.clone())
            .await
            .unwrap();
        supervisor
            .retire_engine("retiring-game".into())
            .await
            .unwrap();
        // The worker's early cancellation path precedes authority resolution, just as it can
        // when retirement wins while a start is queued at the blocking gateway.
        let result = resolve_launch(
            crate::infra::path_authority::SharedPathAuthority::uninitialized(),
            EngineHandle {
                id: executable,
                kind: crate::infra::path_authority::EngineHandleKind::Engine,
            },
            PathOperation::EngineExecute,
            &[],
            &admission,
        )
        .await;
        assert!(matches!(result, Err(Error::EngineRetired)));
        assert!(supervisor.admissions.is_empty());
        assert_eq!(supervisor.spawn_attempts.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn application_id_retirement_rejection_keeps_actor_cleanup_failure() {
        let supervisor = Arc::new(EngineSupervisor::default());
        let key = EngineKey::game("retiring-cleanup", 1, "white", "owner").unwrap();
        let admission = supervisor
            .admit_for_launch(key.clone(), "owner".into(), path_ref("image"))
            .await
            .unwrap();
        let generation = admission.generation();
        supervisor.retire_engine("owner".into()).await.unwrap();
        let actor = Arc::new(EngineActor::new(
            Box::new(TerminateErrorIo),
            EngineDeadlines::default(),
        ));
        assert!(actor.cleanup.is_none());
        let result = initialize_admitted_actor(
            supervisor.clone(),
            key.clone(),
            actor,
            admission,
            |_| async { Ok(()) },
        )
        .await;
        match result {
            Err(error @ Error::OperationAndCleanup { .. }) => {
                assert_eq!(
                    error.category(),
                    crate::error::ErrorCategory::OperationAndCleanup
                );
                assert!(error.diagnostic().contains("Engine id is retired"));
                assert!(error.diagnostic().contains("fake terminate failed"));
            }
            _ => panic!("expected retirement with cleanup failure"),
        }
        assert!(supervisor.get_exact(&key).is_none());
        // This mock reports a termination diagnostic but owns no unresolved OS child.
        assert!(!supervisor.pending_actors.contains_key(&generation));
        assert!(supervisor.admissions.is_empty());
    }

    #[tokio::test]
    async fn ordinary_admission_cancellations_keep_their_identity() {
        for cause in [
            "tab",
            "operation",
            "shutdown",
            "user",
            "executable",
            "binary",
        ] {
            let supervisor = EngineSupervisor::default();
            let key = EngineKey::new(format!("cancel-{cause}"), "owner".into()).unwrap();
            let executable = path_ref("image");
            let cancellation = CancellationToken::new();
            let admission = supervisor
                .admit_for_operation(
                    key.clone(),
                    "owner".into(),
                    executable.clone(),
                    cancellation.clone(),
                )
                .await
                .unwrap();
            match cause {
                "tab" => supervisor.terminate_tab(&key.tab).await.unwrap(),
                "operation" => cancellation.cancel(),
                "shutdown" => supervisor.terminate_all().await.unwrap(),
                "user" => supervisor.kill_engine(&key).await.unwrap(),
                "executable" => supervisor
                    .retire_executables(vec![executable.clone()])
                    .await
                    .unwrap(),
                "binary" => supervisor
                    .retire_engine_binary("owner".into(), executable.clone(), path_ref("new"))
                    .await
                    .unwrap(),
                _ => unreachable!(),
            }
            assert!(
                matches!(admission.cancel_error(), Some(Error::Cancellation)),
                "{cause}"
            );
            if matches!(cause, "shutdown" | "executable" | "binary") {
                assert!(
                    matches!(
                        supervisor
                            .admit_for_launch(key, "owner".into(), executable)
                            .await,
                        Err(Error::Conflict(_))
                    ),
                    "{cause}"
                );
            }
            if matches!(cause, "user" | "operation") {
                supervisor.retire_engine("owner".into()).await.unwrap();
                assert!(matches!(
                    admission.cancel_error(),
                    Some(Error::Cancellation)
                ));
            }
        }
    }

    #[tokio::test]
    async fn retired_engine_id_refuses_static_and_registration_blocked_replacements() {
        let supervisor = Arc::new(EngineSupervisor::default());
        supervisor.retire_engine("retired".into()).await.unwrap();
        let key = EngineKey::new("tab".into(), "retired".into()).unwrap();
        let ((actor, _), terminated) = actor_with(&[], false, None);
        assert!(matches!(
            supervisor.replace(key.clone(), actor).await,
            Err(Error::EngineRetired)
        ));
        assert_eq!(terminated.load(AtomicOrdering::SeqCst), 1);
        assert!(supervisor.get_exact(&key).is_none());

        supervisor
            .retire_engine("cleanup-fails".into())
            .await
            .unwrap();
        let cleanup_key = EngineKey::new("tab".into(), "cleanup-fails".into()).unwrap();
        let cleanup_actor =
            EngineActor::new(Box::new(TerminateErrorIo), EngineDeadlines::default());
        match supervisor.replace(cleanup_key, cleanup_actor).await {
            Err(Error::OperationAndCleanup { primary, cleanup }) => {
                assert_eq!(primary, "Engine id is retired");
                assert!(cleanup.contains("fake terminate failed"));
            }
            other => panic!(
                "expected retired-engine cleanup failure, got {:?}",
                other.map(|_| ())
            ),
        }

        let registration = supervisor.registration.lock().await;
        let race_key = EngineKey::new("tab".into(), "racing".into()).unwrap();
        let ((racing, _), racing_terminated) = actor_with(&[], false, None);
        let replacement = tokio::spawn({
            let supervisor = supervisor.clone();
            let race_key = race_key.clone();
            async move { supervisor.replace(race_key, racing).await }
        });
        while !supervisor.admissions.contains_key(&race_key) {
            tokio::task::yield_now().await;
        }
        let retirement = tokio::spawn({
            let supervisor = supervisor.clone();
            async move { supervisor.retire_engine("racing".into()).await }
        });
        while !supervisor.is_retired("racing") {
            tokio::task::yield_now().await;
        }
        drop(registration);

        retirement.await.unwrap().unwrap();
        assert!(matches!(
            replacement.await.unwrap(),
            Err(Error::EngineRetired)
        ));
        assert_eq!(racing_terminated.load(AtomicOrdering::SeqCst), 1);
        assert!(supervisor.get_exact(&race_key).is_none());
    }

    #[tokio::test]
    async fn retired_engine_ids_evict_the_oldest_at_the_bound() {
        let supervisor = EngineSupervisor::default();
        for index in 0..=MAX_RETIRED_ENGINE_IDS {
            supervisor
                .retire_engine(format!("engine-{index}"))
                .await
                .unwrap();
        }
        assert!(!supervisor.is_retired("engine-0"));
        assert!(supervisor.is_retired(&format!("engine-{MAX_RETIRED_ENGINE_IDS}")));
    }

    #[tokio::test]
    async fn retired_executable_refuses_a_different_engine_id() {
        let supervisor = EngineSupervisor::default();
        let executable = path_ref("retired-path");
        supervisor
            .retire_executables(vec![executable.clone()])
            .await
            .unwrap();
        let key = EngineKey::new("tab".into(), "new-operation".into()).unwrap();
        let ((actor, _), terminated) = actor_with(&[], false, None);

        assert!(matches!(
            supervisor
                .replace_handle(key.clone(), Arc::new(actor), "different-id".into(), executable)
                .await,
            Err(Error::Conflict(message)) if message == "engine executable is retired"
        ));
        assert_eq!(terminated.load(AtomicOrdering::SeqCst), 1);
        assert!(supervisor.get_exact(&key).is_none());
    }

    #[tokio::test]
    async fn retired_executable_recheck_blocks_a_concurrent_publication() {
        let supervisor = Arc::new(EngineSupervisor::default());
        let registration = supervisor.registration.lock().await;
        let executable = path_ref("racing-path");
        let key = EngineKey::new("tab".into(), "operation".into()).unwrap();
        let ((actor, _), terminated) = actor_with(&[], false, None);
        let replacement = tokio::spawn({
            let supervisor = supervisor.clone();
            let key = key.clone();
            let executable = executable.clone();
            async move {
                supervisor
                    .replace_handle(key, Arc::new(actor), "engine-id".into(), executable)
                    .await
            }
        });
        while !supervisor.admissions.contains_key(&key) {
            tokio::task::yield_now().await;
        }
        let retirement = tokio::spawn({
            let supervisor = supervisor.clone();
            let executable = executable.clone();
            async move { supervisor.retire_executables(vec![executable]).await }
        });
        while !supervisor.is_retired_executable(&executable) {
            tokio::task::yield_now().await;
        }
        drop(registration);

        retirement.await.unwrap().unwrap();
        assert!(matches!(
            replacement.await.unwrap(),
            Err(Error::Conflict(_))
        ));
        assert_eq!(terminated.load(AtomicOrdering::SeqCst), 1);
        assert!(supervisor.get_exact(&key).is_none());
    }

    #[tokio::test]
    async fn retired_executables_evict_the_oldest_at_the_bound() {
        let supervisor = EngineSupervisor::default();
        for index in 0..=MAX_RETIRED_PATH_REFS {
            supervisor
                .retire_executables(vec![path_ref(&format!("path-{index}"))])
                .await
                .unwrap();
        }
        assert!(!supervisor.is_retired_executable(&path_ref("path-0")));
        assert!(
            supervisor.is_retired_executable(&path_ref(&format!("path-{MAX_RETIRED_PATH_REFS}")))
        );

        let oldest_key = EngineKey::new("tab".into(), "oldest".into()).unwrap();
        let (oldest, _) = actor(&[]);
        supervisor
            .replace_handle(
                oldest_key.clone(),
                Arc::new(oldest),
                "engine-id".into(),
                path_ref("path-0"),
            )
            .await
            .unwrap();
        let newest_key = EngineKey::new("tab".into(), "newest".into()).unwrap();
        let (newest, _) = actor(&[]);
        assert!(supervisor
            .replace_handle(
                newest_key,
                Arc::new(newest),
                "other-engine-id".into(),
                path_ref(&format!("path-{MAX_RETIRED_PATH_REFS}")),
            )
            .await
            .is_err());
        supervisor.terminate_all().await.unwrap();
    }

    #[tokio::test]
    async fn terminate_all_terminates_registered_actors_concurrently() {
        let supervisor = EngineSupervisor::default();
        let per_actor_delay = Duration::from_millis(100);
        for index in 0..4 {
            let key = EngineKey::new("tab".into(), format!("engine-{index}")).unwrap();
            let ((actor, _), _) = actor_with_terminate_delay(per_actor_delay);
            supervisor.replace(key, actor).await.unwrap();
        }

        let started = std::time::Instant::now();
        supervisor.terminate_all().await.unwrap();
        assert!(
            started.elapsed() < Duration::from_millis(250),
            "four 100 ms terminations must overlap rather than taking their 400 ms sum"
        );
    }

    #[tokio::test]
    async fn terminate_all_seals_the_supervisor_against_replacement() {
        let supervisor = EngineSupervisor::default();
        supervisor.terminate_all().await.unwrap();
        let key = EngineKey::new("tab".into(), "engine".into()).unwrap();
        let ((actor, _), terminated) = actor_with(&[], false, None);

        assert!(matches!(
            supervisor.replace(key, actor).await,
            Err(Error::Conflict(message)) if message == "application is shutting down"
        ));
        assert_eq!(terminated.load(AtomicOrdering::SeqCst), 1);
    }

    #[tokio::test]
    async fn terminate_all_drains_an_actor_published_during_shutdown() {
        let supervisor = Arc::new(EngineSupervisor::default());
        let initial_key = EngineKey::new("tab".into(), "initial".into()).unwrap();
        let ((initial, _), _) = actor_with_terminate_delay(Duration::from_millis(100));
        supervisor.replace(initial_key, initial).await.unwrap();

        let shutdown = tokio::spawn({
            let supervisor = supervisor.clone();
            async move { supervisor.terminate_all().await }
        });
        while !supervisor.sealed.load(Ordering::SeqCst) {
            tokio::task::yield_now().await;
        }
        let slipped_key = EngineKey::new("tab".into(), "slipped".into()).unwrap();
        let ((slipped, _), terminated) = actor_with(&[], false, None);
        supervisor.actors.insert(
            slipped_key.clone(),
            SupervisedEngine::new(
                99,
                "slipped".into(),
                PathRef {
                    id: "slipped-path".into(),
                },
                Arc::new(slipped),
                Arc::new(AtomicBool::new(false)),
            ),
        );

        shutdown.await.unwrap().unwrap();
        assert_eq!(terminated.load(AtomicOrdering::SeqCst), 1);
        assert!(supervisor.get_exact(&slipped_key).is_none());
    }

    #[tokio::test]
    async fn uci_acknowledgement_requires_exact_token() {
        let (actor, writes) = actor(&["uciok-not-an-ack"]);
        assert!(matches!(
            actor.init_uci().await.as_ref().map_err(operation_cause),
            Err(Error::EngineDisconnected)
        ));
        assert_eq!(*writes.lock().await, vec!["uci"]);
    }

    #[tokio::test(start_paused = true)]
    async fn ensure_ready_rejects_a_readyok_prefix() {
        let (io, writes, _, _) = deadline_test_io(
            &[],
            &[
                (Duration::ZERO, Some("readyok-not-an-ack")),
                (Duration::ZERO, None),
            ],
            None,
            Duration::from_millis(10),
        );
        let mut runtime = EngineRuntime::new(Box::new(io), EngineDeadlines::default());

        assert!(matches!(
            runtime
                .ensure_ready(None)
                .await
                .as_ref()
                .map_err(operation_cause),
            Err(Error::EngineDisconnected)
        ));
        assert_eq!(*writes.lock().await, vec!["isready"]);
    }

    #[tokio::test(start_paused = true)]
    async fn infinite_search_reads_can_continue_past_the_per_line_stall_budget() {
        let search_budget = Duration::from_millis(100);
        let read_interval = Duration::from_millis(40);
        let info_line = "info depth 1 score cp 0";
        let info_line_count = 4;
        let (io, _, _, _) = deadline_test_io(&[], &[], Some(info_line), read_interval);
        let actor = EngineActor::new(
            Box::new(io),
            EngineDeadlines {
                search: search_budget,
                ..EngineDeadlines::default()
            },
        );

        let search_started = tokio::time::Instant::now();
        let lines = tokio::time::timeout(search_budget * 3, async {
            let request = actor
                .start_search(&GoMode::Infinite)
                .await
                .expect("infinite search must start");
            let mut lines = Vec::with_capacity(info_line_count);
            for _ in 0..info_line_count {
                lines.push(
                    actor
                        .next_search_line(request)
                        .await
                        .expect("each info-line read must stay within its stall bound"),
                );
            }
            lines
        })
        .await
        .expect("the bounded info-line reads must complete");
        let elapsed = tokio::time::Instant::now() - search_started;

        assert_eq!(lines, vec![Some(info_line.to_owned()); info_line_count]);
        assert!(
            elapsed > search_budget,
            "search elapsed time {elapsed:?} must exceed its per-line stall budget"
        );
        assert!(read_interval < search_budget);
        actor
            .terminate()
            .await
            .expect("fake search actor must terminate");
    }

    #[tokio::test(start_paused = true)]
    async fn chatty_stop_obeys_one_write_inclusive_wall_clock_deadline() {
        let budget = Duration::from_millis(100);
        let read_interval = Duration::from_millis(10);
        let (io, writes, _, _) = deadline_test_io(
            &[("stop", Duration::from_millis(60))],
            &[],
            Some("info depth 1 score cp 0"),
            read_interval,
        );
        let mut runtime = EngineRuntime::new(
            Box::new(io),
            EngineDeadlines {
                stop: budget,
                ..EngineDeadlines::default()
            },
        );
        runtime
            .start_search(&GoMode::Depth(1), None)
            .await
            .expect("search must start before its stop exchange");

        let started = tokio::time::Instant::now();
        let result = tokio::time::timeout(budget * 3, runtime.stop_current(None))
            .await
            .expect("chatty stop must finish within its outer bound");
        let elapsed = tokio::time::Instant::now() - started;

        assert!(matches!(
            result,
            Err(Error::EngineTimeout(message)) if message == "waiting for bestmove after stop"
        ));
        assert!(
            elapsed >= budget - read_interval,
            "stop fired early after {elapsed:?}"
        );
        assert!(
            elapsed <= budget,
            "stop exceeded its deadline after {elapsed:?}"
        );
        assert_eq!(runtime.state, EngineState::Terminating);
        assert_eq!(*writes.lock().await, vec!["go depth 1", "stop"]);
    }

    #[tokio::test(start_paused = true)]
    async fn chatty_readyok_drain_starts_after_the_isready_write() {
        let budget = Duration::from_millis(100);
        let read_interval = Duration::from_millis(10);
        let (io, _, write_completions, _) = deadline_test_io(
            &[("isready", Duration::from_millis(60))],
            &[],
            Some("info depth 1 score cp 0"),
            read_interval,
        );
        let mut runtime = EngineRuntime::new(
            Box::new(io),
            EngineDeadlines {
                readyok: budget,
                ..EngineDeadlines::default()
            },
        );

        let result = tokio::time::timeout(budget * 3, runtime.ensure_ready(None))
            .await
            .expect("chatty readyok drain must finish within its outer bound");
        let completed_at = write_completion_at(&write_completions, "isready");
        let elapsed = tokio::time::Instant::now() - completed_at;

        assert!(matches!(
            result,
            Err(Error::EngineTimeout(message)) if message == "waiting for readyok"
        ));
        assert!(
            elapsed >= budget - read_interval,
            "readyok fired early after {elapsed:?}"
        );
        assert!(
            elapsed <= budget,
            "readyok exceeded its deadline after {elapsed:?}"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn chatty_uciok_drain_starts_after_the_uci_write() {
        let budget = Duration::from_millis(100);
        let read_interval = Duration::from_millis(10);
        let (io, _, write_completions, _) = deadline_test_io(
            &[("uci", Duration::from_millis(60))],
            &[],
            Some("info depth 1 score cp 0"),
            read_interval,
        );
        let mut runtime = EngineRuntime::new(
            Box::new(io),
            EngineDeadlines {
                uciok: budget,
                ..EngineDeadlines::default()
            },
        );
        let cancellation = CancellationToken::new();

        let result = tokio::time::timeout(budget * 3, runtime.init_uci_cancellable(&cancellation))
            .await
            .expect("chatty uciok drain must finish within its outer bound");
        let completed_at = write_completion_at(&write_completions, "uci");
        let elapsed = tokio::time::Instant::now() - completed_at;

        assert!(matches!(
            result,
            Err(Error::EngineTimeout(message)) if message == "waiting for uciok"
        ));
        assert!(
            elapsed >= budget - read_interval,
            "uciok fired early after {elapsed:?}"
        );
        assert!(
            elapsed <= budget,
            "uciok exceeded its deadline after {elapsed:?}"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn chatty_readyok_after_uciok_gets_a_fresh_deadline_after_isready_write() {
        let uciok_budget = Duration::from_millis(100);
        let readyok_budget = Duration::from_millis(300);
        let read_interval = Duration::from_millis(10);
        let (io, _, write_completions, _) = deadline_test_io(
            &[
                ("uci", Duration::from_millis(60)),
                ("isready", Duration::from_millis(180)),
            ],
            &[(Duration::from_millis(70), Some("uciok"))],
            Some("info depth 1 score cp 0"),
            read_interval,
        );
        let mut runtime = EngineRuntime::new(
            Box::new(io),
            EngineDeadlines {
                uciok: uciok_budget,
                readyok: readyok_budget,
                ..EngineDeadlines::default()
            },
        );
        let cancellation = CancellationToken::new();

        let result = tokio::time::timeout(
            uciok_budget + readyok_budget * 3,
            runtime.init_uci_cancellable(&cancellation),
        )
        .await
        .expect("second chatty exchange must finish within its outer bound");
        let isready_completed_at = write_completion_at(&write_completions, "isready");
        let elapsed = tokio::time::Instant::now() - isready_completed_at;

        assert!(matches!(
            result,
            Err(Error::EngineTimeout(message)) if message == "waiting for readyok"
        ));
        assert!(
            elapsed >= readyok_budget - read_interval,
            "readyok reused an earlier deadline or fired early after {elapsed:?}"
        );
        assert!(
            elapsed <= readyok_budget,
            "readyok exceeded its deadline after {elapsed:?}"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn stop_write_uses_the_stop_exchange_deadline_and_poisons_runtime() {
        let stop_budget = Duration::from_millis(100);
        let (io, _, _, _) = deadline_test_io(
            &[("stop", Duration::from_millis(150))],
            &[],
            Some("info depth 1 score cp 0"),
            Duration::from_millis(10),
        );
        let mut runtime = EngineRuntime::new(
            Box::new(io),
            EngineDeadlines {
                stop: stop_budget,
                readyok: Duration::from_millis(500),
                ..EngineDeadlines::default()
            },
        );
        runtime
            .start_search(&GoMode::Depth(1), None)
            .await
            .expect("search must start before stop write exhaustion");
        let started = tokio::time::Instant::now();

        let result = tokio::time::timeout(stop_budget * 3, runtime.stop_current(None))
            .await
            .expect("stop write must be bounded by the outer deadline");
        let elapsed = tokio::time::Instant::now() - started;

        assert!(matches!(
            result,
            Err(Error::EngineTimeout(message)) if message == "writing engine command"
        ));
        assert!(
            elapsed <= stop_budget,
            "stop write exceeded its deadline after {elapsed:?}"
        );
        assert_eq!(runtime.state, EngineState::Terminating);
    }

    #[tokio::test(start_paused = true)]
    async fn plain_send_keeps_its_readyok_write_bound() {
        let budget = Duration::from_millis(100);
        let (io, _, _, _) = deadline_test_io(
            &[("isready", Duration::from_millis(150))],
            &[],
            None,
            Duration::from_millis(10),
        );
        let mut runtime = EngineRuntime::new(
            Box::new(io),
            EngineDeadlines {
                readyok: budget,
                ..EngineDeadlines::default()
            },
        );
        let started = tokio::time::Instant::now();

        let result = tokio::time::timeout(budget * 3, runtime.ensure_ready(None))
            .await
            .expect("plain send must finish within its outer bound");
        let elapsed = tokio::time::Instant::now() - started;

        assert!(matches!(
            result,
            Err(Error::EngineTimeout(message)) if message == "writing engine command"
        ));
        assert!(elapsed >= budget - Duration::from_millis(10));
        assert!(
            elapsed <= budget,
            "plain send exceeded its bound after {elapsed:?}"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn init_uci_cancellable_still_returns_disconnected_when_cancelled_during_uciok() {
        let (io, _, _, _) = deadline_test_io(&[], &[], None, Duration::from_millis(10));
        let mut runtime = EngineRuntime::new(Box::new(io), EngineDeadlines::default());
        let cancellation = CancellationToken::new();

        let (result, ()) = tokio::join!(runtime.init_uci_cancellable(&cancellation), async {
            tokio::time::sleep(Duration::from_millis(20)).await;
            cancellation.cancel();
        });

        assert!(matches!(result, Err(Error::EngineDisconnected)));
    }

    #[tokio::test(start_paused = true)]
    async fn init_uci_cancellable_still_returns_disconnected_when_cancelled_during_readyok() {
        let (io, _, _, _) = deadline_test_io(
            &[],
            &[(Duration::ZERO, Some("uciok"))],
            None,
            Duration::from_millis(10),
        );
        let mut runtime = EngineRuntime::new(Box::new(io), EngineDeadlines::default());
        let cancellation = CancellationToken::new();

        let (result, ()) = tokio::join!(runtime.init_uci_cancellable(&cancellation), async {
            tokio::time::sleep(Duration::from_millis(20)).await;
            cancellation.cancel();
        });

        assert!(matches!(result, Err(Error::EngineDisconnected)));
    }

    #[tokio::test(start_paused = true)]
    async fn stopping_reentry_gets_a_fresh_deadline_without_a_second_stop_write() {
        let budget = Duration::from_millis(100);
        let read_interval = Duration::from_millis(10);
        let (io, writes, _, _) =
            deadline_test_io(&[], &[], Some("info depth 1 score cp 0"), read_interval);
        let mut runtime = EngineRuntime::new(
            Box::new(io),
            EngineDeadlines {
                stop: budget,
                ..EngineDeadlines::default()
            },
        );
        runtime
            .start_search(&GoMode::Depth(1), None)
            .await
            .expect("search must start before stopping");

        assert!(
            tokio::time::timeout(budget * 3 / 5, runtime.stop_current(None))
                .await
                .is_err()
        );
        assert!(matches!(runtime.state, EngineState::Stopping { .. }));
        let second_started = tokio::time::Instant::now();
        let result = tokio::time::timeout(budget * 3, runtime.stop_current(None))
            .await
            .expect("re-entered stop must finish within its outer bound");
        let elapsed = tokio::time::Instant::now() - second_started;

        assert!(matches!(
            result,
            Err(Error::EngineTimeout(message)) if message == "waiting for bestmove after stop"
        ));
        assert!(
            elapsed >= budget - read_interval,
            "re-entered stop fired early after {elapsed:?}"
        );
        assert!(
            elapsed <= budget,
            "re-entered stop exceeded its deadline after {elapsed:?}"
        );
        assert_eq!(
            writes
                .lock()
                .await
                .iter()
                .filter(|line| line.as_str() == "stop")
                .count(),
            1
        );
        assert_eq!(runtime.state, EngineState::Terminating);
    }

    #[tokio::test(start_paused = true)]
    async fn chatty_stop_timeout_reaps_actor_and_rejects_another_search() {
        let budget = Duration::from_millis(100);
        let (io, _, _, terminate_calls) = deadline_test_io(
            &[],
            &[],
            Some("info depth 1 score cp 0"),
            Duration::from_millis(10),
        );
        let actor = EngineActor::new(
            Box::new(io),
            EngineDeadlines {
                stop: budget,
                ..EngineDeadlines::default()
            },
        );
        actor
            .start_search(&GoMode::Depth(1))
            .await
            .expect("first search must start");

        let result = tokio::time::timeout(budget * 3, actor.stop_current())
            .await
            .expect("chatty actor stop must be bounded");
        assert!(matches!(
            result.as_ref().map_err(operation_cause),
            Err(Error::EngineTimeout(message)) if message == "waiting for bestmove after stop"
        ));
        assert!(terminate_calls.load(AtomicOrdering::SeqCst) >= 1);
        assert!(matches!(
            actor
                .start_search(&GoMode::Depth(2))
                .await
                .as_ref()
                .map_err(operation_cause),
            Err(Error::EngineDisconnected)
        ));
    }

    #[tokio::test(start_paused = true)]
    async fn chatty_ensure_ready_timeout_reaps_actor_and_rejects_search() {
        let budget = Duration::from_millis(100);
        let read_interval = Duration::from_millis(10);
        let (io, writes, write_completions, terminate_calls) =
            deadline_test_io(&[], &[], Some("info depth 1 score cp 0"), read_interval);
        let actor = EngineActor::new(
            Box::new(io),
            EngineDeadlines {
                readyok: budget,
                ..EngineDeadlines::default()
            },
        );

        let result = tokio::time::timeout(budget * 3, actor.ensure_ready())
            .await
            .expect("chatty actor readiness must be bounded");
        let isready_completed_at = write_completion_at(&write_completions, "isready");
        let elapsed = tokio::time::Instant::now() - isready_completed_at;

        assert!(matches!(
            result.as_ref().map_err(operation_cause),
            Err(Error::EngineTimeout(message)) if message == "waiting for readyok"
        ));
        assert!(
            elapsed >= budget - read_interval,
            "readyok timeout fired early after {elapsed:?}"
        );
        assert!(
            elapsed <= budget,
            "readyok timeout exceeded its deadline after {elapsed:?}"
        );
        assert_eq!(*writes.lock().await, vec!["isready"]);
        assert!(terminate_calls.load(AtomicOrdering::SeqCst) >= 1);
        assert!(matches!(
            actor
                .start_search(&GoMode::Depth(1))
                .await
                .as_ref()
                .map_err(operation_cause),
            Err(Error::EngineDisconnected)
        ));
    }

    #[tokio::test]
    async fn broken_stdin_does_not_enter_or_leave_a_search_state() {
        let ((actor, _), _) = actor_with(&[], true, None);
        assert!(matches!(
            actor
                .start_search(&GoMode::Depth(1))
                .await
                .as_ref()
                .map_err(operation_cause),
            Err(Error::Io(_))
        ));
    }

    struct PendingChunkReader {
        chunks: VecDeque<Vec<u8>>,
        current: Vec<u8>,
        first_chunk_consumed: Arc<AtomicBool>,
        release: Arc<AtomicBool>,
        error_after_first_chunk: bool,
    }

    impl PendingChunkReader {
        fn new(
            chunks: impl IntoIterator<Item = Vec<u8>>,
            first_chunk_consumed: Arc<AtomicBool>,
            release: Arc<AtomicBool>,
        ) -> Self {
            Self {
                chunks: chunks.into_iter().collect(),
                current: Vec::new(),
                first_chunk_consumed,
                release,
                error_after_first_chunk: false,
            }
        }
    }

    impl AsyncRead for PendingChunkReader {
        fn poll_read(
            mut self: std::pin::Pin<&mut Self>,
            cx: &mut std::task::Context<'_>,
            buffer: &mut ReadBuf<'_>,
        ) -> std::task::Poll<std::io::Result<()>> {
            let this = self.as_mut().get_mut();
            let available = match std::pin::Pin::new(&mut *this).poll_fill_buf(cx) {
                std::task::Poll::Ready(Ok(available)) => available,
                std::task::Poll::Ready(Err(error)) => return std::task::Poll::Ready(Err(error)),
                std::task::Poll::Pending => return std::task::Poll::Pending,
            };
            let take = available.len().min(buffer.remaining());
            buffer.put_slice(&available[..take]);
            std::pin::Pin::new(this).consume(take);
            std::task::Poll::Ready(Ok(()))
        }
    }

    impl AsyncBufRead for PendingChunkReader {
        fn poll_fill_buf(
            self: std::pin::Pin<&mut Self>,
            _cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<std::io::Result<&[u8]>> {
            let this = self.get_mut();
            if this.current.is_empty() {
                if !this.first_chunk_consumed.load(Ordering::SeqCst) {
                    if let Some(chunk) = this.chunks.pop_front() {
                        this.current = chunk;
                    }
                } else if this.error_after_first_chunk {
                    this.error_after_first_chunk = false;
                    return std::task::Poll::Ready(Err(io::Error::other("mid-line read failure")));
                } else if !this.release.load(Ordering::SeqCst) {
                    return std::task::Poll::Pending;
                } else if let Some(chunk) = this.chunks.pop_front() {
                    this.current = chunk;
                } else {
                    return std::task::Poll::Ready(Ok(&[]));
                }
            }
            std::task::Poll::Ready(Ok(&this.current))
        }

        fn consume(self: std::pin::Pin<&mut Self>, amount: usize) {
            let this = self.get_mut();
            let amount = amount.min(this.current.len());
            this.current.drain(..amount);
            if this.current.is_empty() {
                this.first_chunk_consumed.store(true, Ordering::SeqCst);
            }
        }
    }

    #[tokio::test]
    async fn oversized_engine_output_is_rejected_before_log_growth() {
        let oversized = "x".repeat(MAX_ENGINE_LINE_BYTES + 1);
        let writes = Arc::new(Mutex::new(Vec::new()));
        let terminate_calls = Arc::new(AtomicUsize::new(0));
        let mut io = FakeIo::new(writes, [Some(oversized)]);
        io.terminate_calls = terminate_calls;
        let actor = EngineActor::new(Box::new(io), EngineDeadlines::default());
        let id = actor.start_search(&GoMode::Depth(1)).await.unwrap();
        assert!(matches!(
            actor
                .next_search_line(id)
                .await
                .as_ref()
                .map_err(operation_cause),
            Err(Error::ResourceLimit(_))
        ));
        assert!(actor.logs().await.is_err());
        assert!(actor.terminal_snapshot().unwrap().entries.is_empty());
    }

    #[tokio::test]
    async fn bounded_reader_retains_a_partial_line_across_a_dropped_read() {
        let first_chunk_consumed = Arc::new(AtomicBool::new(false));
        let release = Arc::new(AtomicBool::new(false));
        let mut reader = ResumableLineReader::new(PendingChunkReader::new(
            [b"partial ".to_vec(), b"line\n".to_vec()],
            first_chunk_consumed.clone(),
            release.clone(),
        ));
        {
            let read = reader.read_line();
            tokio::pin!(read);
            tokio::time::timeout(Duration::from_secs(1), async {
                tokio::select! {
                    result = &mut read => panic!("read unexpectedly completed: {result:?}"),
                    _ = async {
                        while !first_chunk_consumed.load(Ordering::SeqCst) {
                            tokio::task::yield_now().await;
                        }
                    } => {}
                }
            })
            .await
            .expect("the first chunk must be consumed before the read is dropped");
        }
        assert_eq!(reader.pending_line, b"partial ");

        release.store(true, Ordering::SeqCst);
        assert_eq!(
            reader.read_line().await.unwrap(),
            Some("partial line".into())
        );
    }

    #[tokio::test]
    async fn bounded_reader_enforces_the_size_bound_across_resumed_reads() {
        let first_chunk_consumed = Arc::new(AtomicBool::new(false));
        let release = Arc::new(AtomicBool::new(false));
        let mut reader = ResumableLineReader::new(PendingChunkReader::new(
            [vec![b'x'; MAX_ENGINE_LINE_BYTES - 1], vec![b'x'; 2]],
            first_chunk_consumed.clone(),
            release.clone(),
        ));
        {
            let read = reader.read_line();
            tokio::pin!(read);
            tokio::time::timeout(Duration::from_secs(1), async {
                tokio::select! {
                    result = &mut read => panic!("read unexpectedly completed: {result:?}"),
                    _ = async {
                        while !first_chunk_consumed.load(Ordering::SeqCst) {
                            tokio::task::yield_now().await;
                        }
                    } => {}
                }
            })
            .await
            .expect("the first chunk must be consumed before the read is dropped");
        }
        assert_eq!(reader.pending_line.len(), MAX_ENGINE_LINE_BYTES - 1);

        release.store(true, Ordering::SeqCst);
        assert!(matches!(
            reader.read_line().await,
            Err(Error::ResourceLimit(_))
        ));
        assert!(reader.pending_line.is_empty());
    }

    #[tokio::test]
    async fn child_reader_enforces_the_line_limit_before_allocating_the_payload() {
        let (mut writer, reader) = tokio::io::duplex(1024);
        let payload = vec![b'x'; MAX_ENGINE_LINE_BYTES + 1];
        let writer = tokio::spawn(async move { writer.write_all(&payload).await });
        let mut reader = ResumableLineReader::new(BufReader::new(reader));
        let result = reader.read_line().await;
        assert!(matches!(result, Err(Error::ResourceLimit(_))));
        drop(reader);
        // Closing the hostile stream is expected to interrupt its writer.
        let _ = writer.await;
    }

    #[tokio::test]
    async fn child_reader_normalizes_line_endings() {
        let (mut writer, reader) = tokio::io::duplex(64);
        let writer = tokio::spawn(async move { writer.write_all(b"readyok\r\n").await.unwrap() });
        let mut reader = ResumableLineReader::new(BufReader::new(reader));
        assert_eq!(reader.read_line().await.unwrap(), Some("readyok".into()));
        writer.await.unwrap();
    }

    #[tokio::test]
    async fn replacement_reaps_old_actor_even_when_stop_fails() {
        let supervisor = EngineSupervisor::default();
        let key = EngineKey::new("tab".into(), "engine".into()).unwrap();
        let ((old, _), terminated) = actor_with_stop_failure(&[]);
        old.start_search(&GoMode::Depth(1)).await.unwrap();
        supervisor.replace(key.clone(), old).await.unwrap();
        let (replacement, _) = actor(&[]);
        assert!(supervisor.replace(key.clone(), replacement).await.is_err());
        assert_eq!(terminated.load(AtomicOrdering::SeqCst), 1);
        assert!(supervisor.get_exact(&key).is_none());
    }

    #[tokio::test]
    async fn broken_stdin_does_not_retain_an_already_reaped_actor() {
        let supervisor = EngineSupervisor::default();
        let key = EngineKey::new("tab".into(), "engine".into()).unwrap();
        let ((old, _), terminated) = actor_with(&[], true, None);
        supervisor.replace(key.clone(), old).await.unwrap();

        let (replacement, _) = actor(&[]);
        let replacement = supervisor.replace(key.clone(), replacement).await.unwrap();
        assert_eq!(terminated.load(AtomicOrdering::SeqCst), 1);
        assert_eq!(
            supervisor.get_exact(&key).unwrap().generation,
            replacement.generation
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn termination_preempts_a_silent_search_read() {
        let read_started = Arc::new(AtomicBool::new(false));
        let (actor, _) = delayed_search_actor(
            &["bestmove e2e4"],
            Duration::from_secs(1),
            Some(read_started.clone()),
        );
        let request = actor.start_search(&GoMode::Depth(1)).await.unwrap();
        let waiting = tokio::spawn({
            let actor = actor.clone();
            async move { actor.next_search_line(request).await }
        });
        tokio::time::timeout(Duration::from_secs(1), async {
            while !read_started.load(Ordering::SeqCst) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("the search read must be pending before terminate");
        tokio::time::timeout(Duration::from_millis(50), actor.terminate())
            .await
            .expect("terminate must preempt stdout wait")
            .unwrap();
        match waiting.await.unwrap() {
            Err(Error::EngineDisconnected) => {}
            other => panic!("search waiter after terminate: {other:?}"),
        }
    }

    #[tokio::test]
    async fn termination_reaps_the_actor_task() {
        let ((actor, _), terminated) = actor_with(&[], false, None);

        actor.terminate().await.unwrap();

        assert_eq!(terminated.load(AtomicOrdering::SeqCst), 1);
        assert!(actor.task.lock().await.is_none());
    }

    #[derive(Clone, Copy)]
    enum ExchangeCommand {
        Init,
        ConfigureStart,
        ConfigureNext,
        SetOption,
        SetPosition,
        EnsureReady,
        StartSearch,
        Stop,
        StopRequest,
        SearchStop { control: bool, request: bool },
    }

    /// The same requester and handshake drive every exchange path, including
    /// the Stop arms nested inside a pending search-output read.
    async fn request_exchange(actor: &EngineActor, command: ExchangeCommand) -> Result<(), Error> {
        match command {
            ExchangeCommand::Init => actor.init_uci().await,
            ExchangeCommand::ConfigureStart => actor.start_uci_configuration().await,
            ExchangeCommand::ConfigureNext => actor.next_configuration_line().await.map(|_| ()),
            ExchangeCommand::SetOption => actor.set_option("Threads", "2").await,
            ExchangeCommand::SetPosition => {
                actor
                    .set_position(
                        "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
                        &[],
                    )
                    .await
            }
            ExchangeCommand::EnsureReady => actor.ensure_ready().await,
            ExchangeCommand::StartSearch => actor.start_search(&GoMode::Infinite).await.map(|_| ()),
            ExchangeCommand::Stop => actor.stop_current().await,
            ExchangeCommand::StopRequest => actor.stop_request(EngineRequestId(1)).await,
            ExchangeCommand::SearchStop { control, request } => {
                let (reply_tx, reply) = oneshot::channel();
                let command = if request {
                    EngineCommand::StopRequest {
                        id: EngineRequestId(1),
                        reply: reply_tx,
                    }
                } else {
                    EngineCommand::Stop(reply_tx)
                };
                if control {
                    actor.request_control(command, reply).await?
                } else {
                    actor.request(command, reply).await?
                }
            }
        }
    }

    struct ExchangeCase {
        name: &'static str,
        command: ExchangeCommand,
        state: EngineState,
        search_output_unsynchronized: bool,
        lines: Vec<&'static str>,
        point: ExchangePoint,
    }

    #[tokio::test]
    async fn termination_preempts_every_actor_exchange() {
        use ExchangeCommand::*;
        let write = |command: &str| ExchangePoint::Write(command.into());
        let read = |command: &str| ExchangePoint::ReadAfter(command.into());
        let searching = EngineState::Searching {
            request_id: EngineRequestId(1),
        };
        let cases = vec![
            ExchangeCase {
                name: "init uci write",
                command: Init,
                state: EngineState::Idle,
                search_output_unsynchronized: false,
                lines: vec![],
                point: write("uci"),
            },
            ExchangeCase {
                name: "init isready write",
                command: Init,
                state: EngineState::Idle,
                search_output_unsynchronized: false,
                lines: vec!["uciok"],
                point: write("isready"),
            },
            ExchangeCase {
                name: "init uciok read",
                command: Init,
                state: EngineState::Idle,
                search_output_unsynchronized: false,
                lines: vec![],
                point: read("uci"),
            },
            ExchangeCase {
                name: "init readyok read",
                command: Init,
                state: EngineState::Idle,
                search_output_unsynchronized: false,
                lines: vec!["uciok"],
                point: read("isready"),
            },
            ExchangeCase {
                name: "configure uci write",
                command: ConfigureStart,
                state: EngineState::Idle,
                search_output_unsynchronized: false,
                lines: vec![],
                point: write("uci"),
            },
            ExchangeCase {
                name: "configuration read",
                command: ConfigureNext,
                state: EngineState::Idle,
                search_output_unsynchronized: false,
                lines: vec![],
                point: read(""),
            },
            ExchangeCase {
                name: "setoption write",
                command: SetOption,
                state: EngineState::Idle,
                search_output_unsynchronized: false,
                lines: vec![],
                point: write("setoption name Threads value 2"),
            },
            ExchangeCase {
                name: "position write",
                command: SetPosition,
                state: EngineState::Idle,
                search_output_unsynchronized: false,
                lines: vec![],
                point: write(
                    "position fen rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
                ),
            },
            ExchangeCase {
                name: "ensure isready write",
                command: EnsureReady,
                state: EngineState::Idle,
                search_output_unsynchronized: false,
                lines: vec![],
                point: write("isready"),
            },
            ExchangeCase {
                name: "ensure readyok read",
                command: EnsureReady,
                state: EngineState::Idle,
                search_output_unsynchronized: false,
                lines: vec![],
                point: read("isready"),
            },
            ExchangeCase {
                name: "start implicit stop write",
                command: StartSearch,
                state: searching,
                search_output_unsynchronized: true,
                lines: vec![],
                point: write("stop"),
            },
            ExchangeCase {
                name: "start implicit bestmove read",
                command: StartSearch,
                state: searching,
                search_output_unsynchronized: true,
                lines: vec![],
                point: read("stop"),
            },
            ExchangeCase {
                name: "start resynchronizing readyok read",
                command: StartSearch,
                state: EngineState::Idle,
                search_output_unsynchronized: true,
                lines: vec![],
                point: read("isready"),
            },
            ExchangeCase {
                name: "start go write",
                command: StartSearch,
                state: EngineState::Idle,
                search_output_unsynchronized: false,
                lines: vec![],
                point: write("go infinite"),
            },
            ExchangeCase {
                name: "loop stop drain",
                command: Stop,
                state: searching,
                search_output_unsynchronized: true,
                lines: vec![],
                point: read("stop"),
            },
            ExchangeCase {
                name: "loop stop request drain",
                command: StopRequest,
                state: searching,
                search_output_unsynchronized: true,
                lines: vec![],
                point: read("stop"),
            },
            ExchangeCase {
                name: "search control stop drain",
                command: SearchStop {
                    control: true,
                    request: false,
                },
                state: searching,
                search_output_unsynchronized: true,
                lines: vec![],
                point: read("stop"),
            },
            ExchangeCase {
                name: "search control stop request drain",
                command: SearchStop {
                    control: true,
                    request: true,
                },
                state: searching,
                search_output_unsynchronized: true,
                lines: vec![],
                point: read("stop"),
            },
            ExchangeCase {
                name: "search normal stop drain",
                command: SearchStop {
                    control: false,
                    request: false,
                },
                state: searching,
                search_output_unsynchronized: true,
                lines: vec![],
                point: read("stop"),
            },
        ];
        for ExchangeCase {
            name,
            command,
            state,
            search_output_unsynchronized,
            lines,
            point,
        } in cases
        {
            let (started_tx, started) = oneshot::channel();
            let read_started = Arc::new(AtomicBool::new(false));
            let mut io = FakeIo::new(
                Arc::default(),
                lines.into_iter().map(|line| Some(line.into())),
            );
            io.pending_when_empty = true;
            if let ExchangePoint::Write(command) = &point {
                io.blocked_write = Some(command.clone());
            }
            io.exchange_observation = Some((point, started_tx));
            io.read_observation = read_observation(Some(read_started.clone()), None);
            let reaps = io.terminate_calls.clone();
            let mut runtime = EngineRuntime::new(
                Box::new(io),
                EngineDeadlines {
                    readyok: Duration::from_secs(30),
                    uciok: Duration::from_secs(30),
                    stop: Duration::from_secs(30),
                    search: Duration::from_secs(30),
                    ..EngineDeadlines::default()
                },
            );
            runtime.state = state;
            if matches!(state, EngineState::Searching { .. }) {
                runtime.next_request = 1;
            }
            runtime.search_output_unsynchronized = search_output_unsynchronized;
            let actor = Arc::new(EngineActor::from_runtime(runtime));
            let search_read = if matches!(command, SearchStop { .. }) {
                let actor = actor.clone();
                let task =
                    tokio::spawn(async move { actor.next_search_line(EngineRequestId(1)).await });
                wait_for_flag(&read_started, "search output read before nested Stop").await;
                Some(task)
            } else {
                None
            };
            let requester = tokio::spawn({
                let actor = actor.clone();
                async move { request_exchange(&actor, command).await }
            });
            timeout(Duration::from_secs(2), started)
                .await
                .unwrap()
                .unwrap();
            timeout(Duration::from_millis(500), actor.terminate())
                .await
                .unwrap_or_else(|_| panic!("termination did not preempt {name}"))
                .unwrap();
            let result = timeout(Duration::from_millis(500), requester)
                .await
                .unwrap()
                .unwrap();
            assert!(
                matches!(result, Err(Error::EngineDisconnected)),
                "{name}: {result:?}"
            );
            if let Some(search_read) = search_read {
                assert!(
                    matches!(search_read.await.unwrap(), Err(Error::EngineDisconnected)),
                    "{name}"
                );
            }
            assert_eq!(reaps.load(Ordering::SeqCst), 1, "{name}");
        }
    }

    #[tokio::test]
    async fn cancelled_exchange_never_starts_io() {
        let interrupt = CancellationToken::new();
        interrupt.cancel();
        let writes = Arc::new(Mutex::new(Vec::new()));
        let mut runtime = EngineRuntime::new(
            Box::new(FakeIo::new(writes.clone(), [])),
            EngineDeadlines::default(),
        );
        assert!(matches!(
            runtime.send("uci", Some(&interrupt)).await,
            Err(Error::EngineDisconnected)
        ));
        assert!(writes.lock().await.is_empty());
    }

    fn assert_same_termination_failure(error: &Error, expected: &Error) {
        assert_eq!(error.category(), expected.category());
        assert_eq!(error.to_string(), expected.to_string());
        assert_eq!(error.diagnostic(), expected.diagnostic());
        assert_eq!(error.root_failure(), expected.root_failure());
    }

    #[tokio::test]
    async fn queued_and_later_terminators_report_the_final_reap() {
        for preempted in [false, true] {
            let (started_tx, started) = oneshot::channel();
            let failure = Arc::new(Error::RootFailure {
                error: Box::new(Error::EngineTimeout("injected final reap failure".into())),
                reason: crate::error::RootFailure::Unusable,
            });
            let mut io = FakeIo::new(Arc::default(), []);
            io.pending_when_empty = true;
            io.exchange_observation =
                Some((ExchangePoint::ReadAfter("isready".into()), started_tx));
            io.termination_error = Some(failure.clone());
            // Park the reap so a timeout-triggered recovery has a queued Terminate.
            let gate = TerminationReplyGate::new();
            io.termination_gate = Some(gate.clone());
            let reaps = io.terminate_calls.clone();
            let actor = Arc::new(EngineActor::new(
                Box::new(io),
                EngineDeadlines {
                    readyok: if preempted {
                        Duration::from_secs(30)
                    } else {
                        Duration::from_millis(50)
                    },
                    ..EngineDeadlines::default()
                },
            ));
            let exchange = tokio::spawn({
                let actor = actor.clone();
                async move { actor.ensure_ready().await }
            });
            timeout(Duration::from_secs(2), started)
                .await
                .unwrap()
                .unwrap();
            if !preempted {
                wait_for_flag(
                    &gate.parked,
                    "timeout-triggered recovery parked in teardown",
                )
                .await;
            }
            let termination = tokio::spawn({
                let actor = actor.clone();
                async move { actor.terminate().await }
            });
            // Observe cancellation and the queued request before unblocking teardown.
            timeout(Duration::from_secs(2), async {
                while !actor.interrupt.is_cancelled()
                    || actor.control_tx.capacity() == actor.control_tx.max_capacity()
                {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
            gate.open();
            let error = timeout(Duration::from_millis(500), termination)
                .await
                .unwrap()
                .unwrap()
                .unwrap_err();
            assert_same_termination_failure(&error, &failure);
            let later = actor.as_ref().clone();
            assert_same_termination_failure(&later.terminate().await.unwrap_err(), &failure);
            let exchange_error = exchange.await.unwrap().unwrap_err();
            assert_eq!(
                exchange_error.category(),
                crate::error::ErrorCategory::OperationAndCleanup
            );
            assert_eq!(
                exchange_error.engine_failure_snapshot().is_some(),
                !preempted
            );
            assert_eq!(reaps.load(Ordering::SeqCst), 1);
        }
    }

    #[tokio::test]
    async fn later_terminator_reports_unrequested_protocol_recovery_outcome() {
        for failed in [false, true] {
            let failure = Arc::new(Error::EngineTimeout(
                "unrequested recovery reap failure".into(),
            ));
            let mut io = FakeIo::new(Arc::default(), []);
            io.fail_write = true;
            io.termination_error = failed.then(|| failure.clone());
            let reaps = io.terminate_calls.clone();
            let actor = EngineActor::new(Box::new(io), EngineDeadlines::default());
            assert!(actor.ensure_ready().await.is_err());
            actor.reap_task().await.unwrap();
            let result = actor.terminate().await;
            if failed {
                assert_same_termination_failure(&result.unwrap_err(), &failure);
            } else {
                result.unwrap();
            }
            assert_eq!(reaps.load(Ordering::SeqCst), 1);
        }
    }

    #[tokio::test]
    async fn exact_termination_reports_the_lease_holders_failed_reap() {
        let supervisor = Arc::new(EngineSupervisor::default());
        let key = EngineKey::new("failed-lease-reap".into(), "engine".into()).unwrap();
        let failure = Arc::new(Error::EngineTimeout("lease holder failed reap".into()));
        let mut io = FakeIo::new(Arc::default(), []);
        io.termination_error = Some(failure.clone());
        let gate = TerminationReplyGate::new();
        io.termination_gate = Some(gate.clone());
        let reaps = io.terminate_calls.clone();
        let actor = Arc::new(EngineActor::new(Box::new(io), EngineDeadlines::default()));
        let current = supervisor
            .replace_handle(
                key.clone(),
                actor.clone(),
                key.engine.clone(),
                path_ref("lease-reap"),
            )
            .await
            .unwrap();
        let lifecycle = supervisor.lifecycle_lease(&key);
        let transition = lifecycle.lock().await;
        let terminator = tokio::spawn({
            let supervisor = supervisor.clone();
            let key = key.clone();
            async move { supervisor.terminate_exact(&key, current.generation).await }
        });
        timeout(Duration::from_secs(2), actor.interrupt.cancelled())
            .await
            .unwrap();
        // The observed interrupt proves exact termination crossed its barrier
        // and is waiting for the lease still held by this transition owner.
        wait_for_pending_termination(&gate).await;
        let mut reaper = Box::pin(supervisor.reap_published(&key, current.generation));
        assert!(futures_util::poll!(reaper.as_mut()).is_pending());
        gate.open();
        let error = reaper.await.unwrap_err();
        assert_same_termination_failure(&error, &failure);
        assert!(supervisor.get_exact(&key).is_none());
        assert!(!supervisor.pending_actors.contains_key(&current.generation));
        drop(transition);
        assert_same_termination_failure(&terminator.await.unwrap().unwrap_err(), &failure);
        assert_eq!(reaps.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn drain_reports_a_failed_reap_completed_after_its_snapshot() {
        let supervisor = Arc::new(EngineSupervisor::default());
        let key = EngineKey::new("failed-snapshot-reap".into(), "engine".into()).unwrap();
        let failure = Arc::new(Error::EngineTimeout("snapshot target failed reap".into()));
        let mut io = FakeIo::new(Arc::default(), []);
        io.termination_error = Some(failure.clone());
        let reap_gate = TerminationReplyGate::new();
        io.termination_gate = Some(reap_gate.clone());
        let reaps = io.terminate_calls.clone();
        let actor = Arc::new(EngineActor::new(Box::new(io), EngineDeadlines::default()));
        let current = supervisor
            .replace_handle(
                key.clone(),
                actor,
                key.engine.clone(),
                path_ref("snapshot-reap"),
            )
            .await
            .unwrap();
        let gate = TerminationReplyGate::new();
        TEARDOWN_SNAPSHOT_GATES.arm((key.clone(), current.generation), gate.clone());
        let drain = tokio::spawn({
            let supervisor = supervisor.clone();
            async move { supervisor.terminate_all().await }
        });
        wait_for_flag(&gate.parked, "drain's actor snapshot").await;
        wait_for_pending_termination(&reap_gate).await;
        let mut reaper = Box::pin(supervisor.reap_published(&key, current.generation));
        assert!(futures_util::poll!(reaper.as_mut()).is_pending());
        reap_gate.open();
        assert_same_termination_failure(&reaper.await.unwrap_err(), &failure);
        assert!(supervisor.get_exact(&key).is_none());
        assert!(!supervisor.pending_actors.contains_key(&current.generation));
        gate.open();
        assert_same_termination_failure(&drain.await.unwrap().unwrap_err(), &failure);
        assert_eq!(reaps.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn termination_preempts_a_pending_replacements_stop() {
        let mut missed_bounds = Vec::new();
        for through_drain in [true, false] {
            let supervisor = Arc::new(EngineSupervisor::default());
            let key = EngineKey::new("pending-replacement-stop".into(), "engine".into()).unwrap();
            let (started_tx, started) = oneshot::channel();
            let mut io = FakeIo::new(Arc::default(), []);
            io.pending_when_empty = true;
            io.exchange_observation = Some((ExchangePoint::ReadAfter("stop".into()), started_tx));
            let reaps = io.terminate_calls.clone();
            let actor = Arc::new(EngineActor::new(
                Box::new(io),
                EngineDeadlines {
                    readyok: Duration::from_secs(30),
                    uciok: Duration::from_secs(30),
                    stop: Duration::from_secs(30),
                    search: Duration::from_secs(30),
                    ..EngineDeadlines::default()
                },
            ));
            let current = supervisor
                .replace_handle(
                    key.clone(),
                    actor.clone(),
                    key.engine.clone(),
                    path_ref("old-pending-stop"),
                )
                .await
                .unwrap();
            actor.start_search(&GoMode::Infinite).await.unwrap();
            // Exercise publication itself, including handoff and its graceful
            // Stop under the lifecycle lease, rather than constructing pending state.
            let replacement = tokio::spawn({
                let supervisor = supervisor.clone();
                let key = key.clone();
                async move {
                    supervisor
                        .replace_handle(
                            key.clone(),
                            Arc::new(EngineActor::new(
                                Box::new(FakeIo::new(Arc::default(), [])),
                                EngineDeadlines::default(),
                            )),
                            key.engine.clone(),
                            path_ref("new-pending-stop"),
                        )
                        .await
                }
            });
            timeout(Duration::from_secs(2), started)
                .await
                .unwrap()
                .unwrap();
            assert!(supervisor.get_exact(&key).is_none());
            assert!(supervisor
                .pending_actors
                .get(&current.generation)
                .is_some_and(|pending| pending.key == key
                    && pending
                        .actor
                        .get()
                        .is_some_and(|pending| Arc::ptr_eq(pending, &actor))));
            assert!(!actor.interrupt.is_cancelled());
            let mut termination = if through_drain {
                let supervisor = supervisor.clone();
                let tab = key.tab.clone();
                tokio::spawn(async move { supervisor.terminate_tab(&tab).await })
            } else {
                tokio::spawn({
                    let supervisor = supervisor.clone();
                    let key = key.clone();
                    async move { supervisor.terminate_exact(&key, current.generation).await }
                })
            };
            let observed = match timeout(Duration::from_millis(500), &mut termination).await {
                Ok(result) => result.unwrap().unwrap_err(),
                Err(_) => {
                    missed_bounds.push(if through_drain {
                        "drain"
                    } else {
                        "direct exact"
                    });
                    // Keep the deliberate removal probe bounded and reap its fake
                    // runtime before proceeding to the other table row.
                    actor.terminate().await.unwrap();
                    termination.await.unwrap().unwrap_err()
                }
            };
            let result = timeout(Duration::from_millis(500), replacement)
                .await
                .unwrap()
                .unwrap();
            let result = result.map(|_| ()).unwrap_err();
            assert!(matches!(result.without_shared(), Error::EngineDisconnected));
            assert_same_termination_failure(&observed, &result);
            assert_eq!(reaps.load(Ordering::SeqCst), 1);
            assert!(!supervisor.pending_actors.contains_key(&current.generation));
            assert!(supervisor.get_exact(&key).is_none());
        }
        assert!(
            missed_bounds.is_empty(),
            "termination failed the 500 ms bound: {missed_bounds:?}"
        );
    }

    #[tokio::test]
    async fn concurrent_terminators_share_reap_and_join_failures() {
        for abort_task in [false, true] {
            let failure = Arc::new(Error::RootFailure {
                error: Box::new(Error::EngineTimeout("concurrent final reap failure".into())),
                reason: crate::error::RootFailure::Unusable,
            });
            let gate = TerminationReplyGate::new();
            let mut io = FakeIo::new(Arc::default(), []);
            io.termination_gate = Some(gate.clone());
            io.termination_error = Some(failure.clone());
            let reaps = io.terminate_calls.clone();
            let actor = EngineActor::new(Box::new(io), EngineDeadlines::default());
            let abort = actor.task.lock().await.as_ref().unwrap().abort_handle();
            let first = tokio::spawn({
                let actor = actor.clone();
                async move { actor.terminate().await }
            });
            wait_for_flag(&gate.parked, "first termination parked in runtime teardown").await;
            let second = tokio::spawn({
                let actor = actor.clone();
                async move { actor.terminate().await }
            });
            // The first request is being serviced and the second is queued.
            // Both callers must still be waiting before teardown is released.
            timeout(Duration::from_secs(2), async {
                while actor.control_tx.capacity() == actor.control_tx.max_capacity() {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
            assert!(!first.is_finished());
            assert!(!second.is_finished());
            if abort_task {
                abort.abort();
            } else {
                gate.open();
            }
            let first = timeout(Duration::from_millis(500), first)
                .await
                .unwrap()
                .unwrap()
                .unwrap_err();
            let second = timeout(Duration::from_millis(500), second)
                .await
                .unwrap()
                .unwrap()
                .unwrap_err();
            assert_same_termination_failure(&second, &first);
            if abort_task {
                assert!(matches!(first, Error::OperationAndCleanup { .. }));
                assert!(first.diagnostic().contains("engine actor task failed"));
                assert_eq!(reaps.load(Ordering::SeqCst), 0);
            } else {
                assert_same_termination_failure(&first, &failure);
                assert_eq!(reaps.load(Ordering::SeqCst), 1);
            }
        }
    }

    fn fake_io() -> FakeIo {
        FakeIo::new(
            Arc::new(Mutex::new(Vec::new())),
            std::iter::empty::<Option<String>>(),
        )
    }

    fn pending_stderr_drain(finished: Arc<AtomicBool>) -> tokio::task::JoinHandle<()> {
        pending_stderr_drain_started(finished, None)
    }

    fn pending_stderr_drain_started(
        finished: Arc<AtomicBool>,
        started: Option<oneshot::Sender<()>>,
    ) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            struct Flag(Arc<AtomicBool>);
            impl Drop for Flag {
                fn drop(&mut self) {
                    self.0.store(true, AtomicOrdering::SeqCst);
                }
            }
            let _flag = Flag(finished);
            if let Some(started) = started {
                let _ = started.send(());
            }
            std::future::pending::<()>().await;
        })
    }

    #[tokio::test]
    async fn stop_current_keeps_the_stderr_drain_alive() {
        let mut io = fake_io();
        io.lines
            .push_back((Duration::ZERO, Some("bestmove e2e4".into())));
        let mut runtime = EngineRuntime::new(Box::new(io), EngineDeadlines::default());
        let finished = Arc::new(AtomicBool::new(false));
        let (started_tx, started_rx) = oneshot::channel();
        runtime.stderr_drain_task = Some(pending_stderr_drain_started(
            finished.clone(),
            Some(started_tx),
        ));
        started_rx.await.unwrap();
        runtime.start_search(&GoMode::Depth(1), None).await.unwrap();

        runtime.stop_current(None).await.unwrap();

        assert!(runtime.stderr_drain_task.is_some());
        assert!(
            !finished.load(AtomicOrdering::SeqCst),
            "stop must not abort the stderr drain"
        );
    }

    #[tokio::test]
    async fn stderr_drain_consumes_input_after_the_log_budget_is_exceeded() {
        let chunk = vec![b'x'; MAX_ENGINE_LINE_BYTES / 2];
        let mut input = Vec::new();
        while input.len() <= MAX_ENGINE_STDERR_BYTES {
            input.extend_from_slice(&chunk);
            input.push(b'\n');
        }
        input.extend_from_slice(b"still-alive\n");
        let mut reader = ResumableLineReader::new(BufReader::new(std::io::Cursor::new(input)));

        drain_engine_stderr(&mut reader, &Mutex::new(TerminalDiagnostics::default())).await;

        assert!(
            reader.reader.fill_buf().await.unwrap().is_empty(),
            "stderr drain must continue through EOF"
        );
    }

    #[tokio::test]
    async fn stderr_drain_discards_an_oversized_line_and_consumes_the_next_line() {
        let mut input = vec![b'x'; MAX_ENGINE_LINE_BYTES + 1];
        input.extend_from_slice(b"\nstill-alive\n");
        let mut reader = ResumableLineReader::new(BufReader::new(std::io::Cursor::new(input)));

        drain_engine_stderr(&mut reader, &Mutex::new(TerminalDiagnostics::default())).await;

        assert!(
            reader.reader.fill_buf().await.unwrap().is_empty(),
            "oversized stderr lines must not stop or spin the drain"
        );
    }

    #[tokio::test]
    async fn terminate_lets_the_stderr_drain_finish_naturally_after_child_reap() {
        let finished_naturally = Arc::new(AtomicBool::new(false));
        let flag = finished_naturally.clone();
        let drain = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(30)).await;
            flag.store(true, AtomicOrdering::SeqCst);
        });
        let mut runtime = EngineRuntime::new(Box::new(fake_io()), EngineDeadlines::default());
        runtime.stderr_drain_task = Some(drain);

        runtime.terminate().await.unwrap();

        assert!(
            finished_naturally.load(AtomicOrdering::SeqCst),
            "terminate must join the drain after child reap instead of aborting it immediately"
        );
    }

    #[tokio::test]
    async fn cancelling_terminate_aborts_the_taken_stderr_drain() {
        let finished = Arc::new(AtomicBool::new(false));
        let (started_tx, started_rx) = oneshot::channel();
        let mut runtime = EngineRuntime::new(Box::new(fake_io()), EngineDeadlines::default());
        runtime.stderr_drain_task = Some(pending_stderr_drain_started(
            finished.clone(),
            Some(started_tx),
        ));
        started_rx.await.unwrap();

        assert!(
            tokio::time::timeout(Duration::from_millis(5), runtime.terminate())
                .await
                .is_err(),
            "terminate must still be joining when the cancellation timeout fires"
        );
        tokio::time::timeout(Duration::from_millis(200), async {
            while !finished.load(AtomicOrdering::SeqCst) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("a cancelled reap must leave the stderr drain terminal");
    }

    #[tokio::test]
    async fn terminate_joins_a_finished_stderr_drain() {
        let handle = tokio::spawn(async {});
        let mut runtime = EngineRuntime::new(Box::new(fake_io()), EngineDeadlines::default());
        runtime.stderr_drain_task = Some(handle);
        tokio::time::timeout(Duration::from_millis(50), runtime.terminate())
            .await
            .expect("joining a finished stderr drain must not wait out the reap timeout")
            .unwrap();
        assert!(runtime.stderr_drain_task.is_none());
    }

    #[tokio::test]
    async fn terminate_aborts_a_stuck_stderr_drain() {
        let finished = Arc::new(AtomicBool::new(false));
        let mut runtime = EngineRuntime::new(Box::new(fake_io()), EngineDeadlines::default());
        runtime.stderr_drain_task = Some(pending_stderr_drain(finished.clone()));
        tokio::time::timeout(
            STDERR_REAP_TIMEOUT + Duration::from_millis(100),
            runtime.terminate(),
        )
        .await
        .expect("terminate must abort a stuck stderr drain")
        .unwrap();
        assert!(runtime.stderr_drain_task.is_none());
        assert!(
            finished.load(AtomicOrdering::SeqCst),
            "stderr drain must reach a terminal state on terminate"
        );
    }

    #[tokio::test]
    async fn dropping_the_runtime_aborts_the_stderr_drain() {
        let finished = Arc::new(AtomicBool::new(false));
        let (started_tx, started_rx) = oneshot::channel();
        {
            let mut runtime = EngineRuntime::new(Box::new(fake_io()), EngineDeadlines::default());
            runtime.stderr_drain_task = Some(pending_stderr_drain_started(
                finished.clone(),
                Some(started_tx),
            ));
            started_rx.await.unwrap();
        }
        let deadline = tokio::time::Instant::now() + Duration::from_millis(200);
        while !finished.load(AtomicOrdering::SeqCst) {
            if tokio::time::Instant::now() > deadline {
                panic!("stderr drain must be aborted when the runtime is dropped");
            }
            tokio::task::yield_now().await;
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn spawn_owns_the_stderr_drain_until_terminate() {
        let directory = tempfile::tempdir().unwrap();
        let script = directory.path().join("uci-stderr.sh");
        crate::infra::test_executable::publish_test_executable(
            &script,
            "#!/bin/sh\necho boot >&2\nwhile IFS= read -r line; do case \"$line\" in quit) exit 0;; esac; done\n", 0o700)
        .unwrap();
        let executable = crate::infra::path_authority::EngineExecutable::test_fixture(
            std::fs::File::open(&script).unwrap(),
            directory.path().to_path_buf(),
            vec![],
        );
        let mut runtime = EngineRuntime::spawn(executable, EngineDeadlines::default())
            .await
            .unwrap();
        assert!(
            runtime.stderr_drain_task.is_some(),
            "spawn must keep the stderr drain JoinHandle"
        );
        tokio::time::timeout(Duration::from_secs(2), runtime.terminate())
            .await
            .expect("terminate must join the stderr drain after the child exits")
            .unwrap();
        assert!(runtime.stderr_drain_task.is_none());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn real_child_ignoring_quit_is_force_killed_within_reap_budget() {
        let directory = tempfile::tempdir().unwrap();
        #[cfg(target_os = "linux")]
        let writer = hold_original_waiting_script_open_for_writing(&directory, "ignore-quit.sh");
        let executable = stdin_waiting_executable(&directory);
        let deadlines = EngineDeadlines {
            quit: Duration::from_millis(20),
            kill_reap: Duration::from_millis(200),
            ..EngineDeadlines::default()
        };
        let mut runtime = EngineRuntime::spawn(executable, deadlines).await.unwrap();
        let started = std::time::Instant::now();

        runtime.terminate().await.unwrap();

        assert!(
            started.elapsed() < Duration::from_millis(500),
            "quit-ignoring child must not outlive quit + kill_reap + slack"
        );
        #[cfg(target_os = "linux")]
        drop(writer);
    }

    #[cfg(unix)]
    fn assert_child_is_reaped(pid: u32) {
        for _ in 0..100 {
            let result = unsafe { libc::kill(pid as libc::pid_t, 0) };
            if result == -1 && io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) {
                return;
            }
            std::thread::sleep(Duration::from_millis(1));
        }
        let result = unsafe { libc::kill(pid as libc::pid_t, 0) };
        assert_eq!(result, -1, "child {pid} still exists after spawn failure");
        assert_eq!(
            io::Error::last_os_error().raw_os_error(),
            Some(libc::ESRCH),
            "child {pid} was not reaped"
        );
    }

    #[cfg(unix)]
    fn child_pid_published_when_spawn_completed(
        pid_rx: &std::sync::mpsc::Receiver<Option<u32>>,
        spawn_result: &Result<EngineRuntime, Error>,
    ) -> u32 {
        match pid_rx.try_recv() {
            Ok(Some(pid)) => pid,
            published => panic!(
                "spawn observer must have published a child pid by the time spawn completed; channel={published:?}; spawn={}",
                spawn_outcome(spawn_result)
            ),
        }
    }

    #[cfg(unix)]
    fn spawn_outcome(spawn_result: &Result<EngineRuntime, Error>) -> String {
        match spawn_result {
            Ok(_) => "Ok(runtime)".to_string(),
            Err(error) => format!("Err({error:?})"),
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn spawn_io_take_failures_force_kill_and_reap_child() {
        for failure in [SpawnIoFailure::NoStdin, SpawnIoFailure::NoStdout] {
            let directory = tempfile::tempdir().unwrap();
            let executable = stdin_waiting_observer_executable(&directory);
            let command_target = executable.command_target().to_path_buf();
            let (pid_tx, pid_rx) = std::sync::mpsc::channel();
            let _observer = set_spawn_child_observer(
                command_target,
                Box::new(move |pid| {
                    let _ = pid_tx.send(pid);
                }),
            );
            set_spawn_io_failure(Some(failure));
            // The default reap budget, not a shortened one: a SIGKILLed child that is not
            // reaped in time turns the injected I/O error into `OperationAndCleanup`, which a
            // loaded coverage runner can hit at 200 ms (f-20261116-02).
            let result = EngineRuntime::spawn(executable, EngineDeadlines::default()).await;
            set_spawn_io_failure(None);

            let pid = child_pid_published_when_spawn_completed(&pid_rx, &result);
            let expected = match failure {
                SpawnIoFailure::NoStdin => matches!(result, Err(Error::NoStdin)),
                SpawnIoFailure::NoStdout => matches!(result, Err(Error::NoStdout)),
            };
            assert!(
                expected,
                "{failure:?} injection must fail spawn with exactly that error; spawn={}",
                spawn_outcome(&result)
            );
            assert_child_is_reaped(pid);
        }

        let directory = tempfile::tempdir().unwrap();
        let executable = stdin_waiting_observer_executable(&directory);
        let command_target = executable.command_target().to_path_buf();
        let (pid_tx, pid_rx) = std::sync::mpsc::channel();
        let _observer = set_spawn_child_observer(
            command_target,
            Box::new(move |pid| {
                let _ = pid_tx.send(pid);
            }),
        );
        set_spawn_io_failure(Some(SpawnIoFailure::NoStdin));
        set_terminate_failure(Some(TerminateFailure::ReapError));
        // The injected reap error waits for the real child first; the default budget keeps
        // `assert_child_is_reaped` independent of runner load.
        let result = EngineRuntime::spawn(executable, EngineDeadlines::default()).await;
        set_spawn_io_failure(None);
        set_terminate_failure(None);

        let pid = child_pid_published_when_spawn_completed(&pid_rx, &result);
        // Match the injected cause, so a reap timeout (also `OperationAndCleanup`) cannot pass.
        assert!(
            matches!(
                &result,
                Err(Error::OperationAndCleanup { primary, cleanup })
                    if *primary == Error::NoStdin.diagnostic()
                        && cleanup.contains("injected engine reap failure")
            ),
            "an injected reap error must surface as OperationAndCleanup; spawn={}",
            spawn_outcome(&result)
        );
        assert_child_is_reaped(pid);
    }

    #[cfg(unix)]
    #[test]
    fn spawn_child_observer_guard_preserves_replacement_registration() {
        let command_target = std::path::PathBuf::from("spawn-child-observer-guard-replacement");
        let first_guard = set_spawn_child_observer(command_target.clone(), Box::new(|_| {}));
        let (pid_tx, pid_rx) = std::sync::mpsc::channel();
        let _second_guard = set_spawn_child_observer(
            command_target.clone(),
            Box::new(move |pid| pid_tx.send(pid).unwrap()),
        );

        drop(first_guard);

        let observer = take_spawn_child_observer(&command_target)
            .expect("dropping a stale guard must preserve the replacement observer");
        observer(Some(42));
        assert_eq!(pid_rx.try_recv().unwrap(), Some(42));
    }

    #[cfg(unix)]
    #[test]
    fn spawn_child_observer_guard_removes_owned_registration() {
        let command_target = std::path::PathBuf::from("spawn-child-observer-guard-owner-cleanup");
        let guard = set_spawn_child_observer(command_target.clone(), Box::new(|_| {}));

        drop(guard);

        assert!(
            take_spawn_child_observer(&command_target).is_none(),
            "dropping the owning guard must remove its unconsumed observer"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn spawn_child_observers_are_isolated_by_command_target() {
        let directory = tempfile::tempdir().unwrap();
        let script_a = directory.path().join("observer-a.sh");
        let script_b = directory.path().join("observer-b.sh");
        let marker_a = directory.path().join("observer-a.pid");
        let marker_b = directory.path().join("observer-b.pid");
        for (script, marker) in [(&script_a, &marker_a), (&script_b, &marker_b)] {
            crate::infra::test_executable::publish_test_executable(
                script,
                format!(
                    "#!/bin/sh\nmarker='{}'\nprintf '%s\\n' \"$$\" > \"$marker.tmp\"\nmv \"$marker.tmp\" \"$marker\"\nwhile IFS= read -r line; do [ \"$line\" = quit ] && exit 0; done\n",
                    marker.display()
                ), 0o700)
            .unwrap();
        }
        let executable_a = EngineExecutable::test_fixture(
            std::fs::File::open(&script_a).unwrap(),
            directory.path().to_path_buf(),
            Vec::new(),
        );
        let executable_b = EngineExecutable::test_fixture(
            std::fs::File::open(&script_b).unwrap(),
            directory.path().to_path_buf(),
            Vec::new(),
        );
        let target_a = executable_a.command_target().to_path_buf();
        let target_b = executable_b.command_target().to_path_buf();
        let (pid_a_tx, pid_a_rx) = std::sync::mpsc::channel();
        let (pid_b_tx, pid_b_rx) = std::sync::mpsc::channel();
        let _observer_a = set_spawn_child_observer(
            target_a,
            Box::new(move |pid| {
                let _ = pid_a_tx.send(pid);
            }),
        );
        let _observer_b = set_spawn_child_observer(
            target_b,
            Box::new(move |pid| {
                let _ = pid_b_tx.send(pid);
            }),
        );

        let (result_a, result_b) = tokio::join!(
            EngineRuntime::spawn(executable_a, EngineDeadlines::default()),
            EngineRuntime::spawn(executable_b, EngineDeadlines::default()),
        );
        let mut runtime_a = match result_a {
            Ok(runtime) => runtime,
            Err(error) => {
                if let Ok(mut runtime) = result_b {
                    let _ = runtime.terminate().await;
                }
                panic!("observer A runtime failed to spawn: {error}");
            }
        };
        let mut runtime_b = match result_b {
            Ok(runtime) => runtime,
            Err(error) => {
                let _ = runtime_a.terminate().await;
                panic!("observer B runtime failed to spawn: {error}");
            }
        };

        let marker_pids = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let pid_a = std::fs::read_to_string(&marker_a)
                    .ok()
                    .and_then(|pid| pid.trim().parse::<u32>().ok());
                let pid_b = std::fs::read_to_string(&marker_b)
                    .ok()
                    .and_then(|pid| pid.trim().parse::<u32>().ok());
                if let (Some(pid_a), Some(pid_b)) = (pid_a, pid_b) {
                    break (pid_a, pid_b);
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await;
        let observed_a = pid_a_rx.recv_timeout(Duration::from_secs(1));
        let observed_b = pid_b_rx.recv_timeout(Duration::from_secs(1));
        let termination_a = runtime_a.terminate().await;
        let termination_b = runtime_b.terminate().await;

        let (actual_a, actual_b) =
            marker_pids.expect("both observer child markers must contain pids");
        assert!(termination_a.is_ok(), "observer A child must terminate");
        assert!(termination_b.is_ok(), "observer B child must terminate");
        assert_eq!(observed_a.ok().flatten(), Some(actual_a));
        assert_eq!(observed_b.ok().flatten(), Some(actual_b));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn logs_preempt_a_silent_search_read_without_cancelling_the_search() {
        let read_started = Arc::new(AtomicBool::new(false));
        let (actor, _) = delayed_search_actor(
            &["bestmove e2e4"],
            Duration::from_secs(1),
            Some(read_started.clone()),
        );
        let request = actor.start_search(&GoMode::Depth(1)).await.unwrap();
        let waiting = tokio::spawn({
            let actor = actor.clone();
            async move { actor.next_search_line(request).await }
        });
        tokio::time::timeout(Duration::from_secs(1), async {
            while !read_started.load(Ordering::SeqCst) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("the search read must be pending before logs");

        tokio::time::timeout(Duration::from_millis(50), actor.logs())
            .await
            .expect("logs must preempt stdout wait")
            .unwrap();
        assert_eq!(
            tokio::time::timeout(Duration::from_millis(50), waiting)
                .await
                .expect("search must remain active after logs")
                .unwrap()
                .unwrap(),
            Some("bestmove e2e4".into())
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn terminate_bypasses_a_flooded_normal_command_queue() {
        let read_started = Arc::new(AtomicBool::new(false));
        let (actor, _) = delayed_search_actor(
            &["bestmove e2e4"],
            Duration::from_secs(1),
            Some(read_started.clone()),
        );
        let request = actor.start_search(&GoMode::Depth(1)).await.unwrap();
        let waiting = tokio::spawn({
            let actor = actor.clone();
            async move { actor.next_search_line(request).await }
        });
        tokio::time::timeout(Duration::from_secs(1), async {
            while !read_started.load(Ordering::SeqCst) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("the search read must be pending before the flood");

        let mut queued = Vec::new();
        for index in 0..32 {
            queued.push(
                actor
                    .try_enqueue_set_option(format!("Option{index}"), "1".into())
                    .expect("normal queue must accept 32 set_option commands while searching"),
            );
        }

        tokio::time::timeout(Duration::from_millis(50), actor.terminate())
            .await
            .expect("terminate must bypass normal queue")
            .unwrap();
        match waiting.await.unwrap() {
            Err(Error::EngineDisconnected) => {}
            other => panic!("search waiter after terminate: {other:?}"),
        }
        drop(queued);
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "current_thread")]
    async fn resource_verification_isolated_gateway_keeps_actor_control_responsive() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("resource");
        std::fs::write(&path, b"resource").unwrap();
        let lease = Arc::new(
            crate::infra::path_authority::EngineResourceLease::test_file(
                std::fs::File::open(&path).unwrap(),
            ),
        );
        #[cfg(target_os = "macos")]
        lease.pin_test_target_to_original().unwrap();
        let value = lease.uci_value().unwrap();
        let (actor, writes) = EngineActor::recording_test_actor_with_resources(&[], vec![lease]);
        let options = vec![ResolvedEngineOption {
            name: "EvalFile".into(),
            value: value.clone(),
            resources: Vec::new(),
            resource_values: vec![value.clone()],
        }];
        let gateway = Arc::new(BlockingGateway::new(1));
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        set_resource_verify_hook(
            value.clone(),
            Some(Box::new(move || {
                let _ = entered_tx.send(());
                release_rx.recv().unwrap();
            })),
        );
        let task_gateway = gateway.clone();
        let verification = tokio::spawn({
            let actor = actor.clone();
            async move { verify_option_resources_in(&task_gateway, &actor, &options, None).await }
        });
        tokio::time::timeout(std::time::Duration::from_secs(1), entered_rx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(gateway.available_permits(), 0);
        tokio::time::timeout(std::time::Duration::from_millis(100), actor.terminate())
            .await
            .unwrap()
            .unwrap();
        release_tx.send(()).unwrap();
        assert!(matches!(
            verification.await.unwrap(),
            Err(Error::Cancellation)
        ));
        assert!(writes.lock().await.is_empty());
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "current_thread")]
    async fn resource_verification_timeout_returns_without_sending_setoption() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("resource");
        std::fs::write(&path, b"resource").unwrap();
        let lease = Arc::new(
            crate::infra::path_authority::EngineResourceLease::test_file(
                std::fs::File::open(&path).unwrap(),
            ),
        );
        #[cfg(target_os = "macos")]
        lease.pin_test_target_to_original().unwrap();
        let value = lease.uci_value().unwrap();
        let deadlines = EngineDeadlines {
            resource_verify: std::time::Duration::from_millis(500),
            ..EngineDeadlines::default()
        };
        let (actor, writes) = EngineActor::recording_test_actor_with_resources_and_deadlines(
            &[],
            vec![lease],
            deadlines,
        );
        let options = vec![ResolvedEngineOption {
            name: "EvalFile".into(),
            value: value.clone(),
            resources: Vec::new(),
            resource_values: vec![value.clone()],
        }];
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        set_resource_verify_hook(
            value.clone(),
            Some(Box::new(move || {
                let _ = entered_tx.send(());
                release_rx.recv().unwrap();
            })),
        );
        let gateway = Arc::new(BlockingGateway::new(1));
        let task_gateway = gateway.clone();
        let verification = tokio::spawn({
            let actor = actor.clone();
            async move { verify_option_resources_in(&task_gateway, &actor, &options, None).await }
        });
        tokio::time::timeout(std::time::Duration::from_secs(1), entered_rx)
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(
            verification.await.unwrap(),
            Err(Error::EngineTimeout(message)) if message == "verifying engine option resources"
        ));
        release_tx.send(()).unwrap();
        assert!(writes.lock().await.is_empty());
        actor.terminate().await.unwrap();
    }

    #[tokio::test]
    async fn unheld_resource_values_are_refused_before_the_first_setoption() {
        let (actor, writes) = EngineActor::recording_test_actor(&[]);
        let options = [ResolvedEngineOption {
            name: "EvalFile".into(),
            value: "/unheld/resource".into(),
            resources: Vec::new(),
            resource_values: vec!["/unheld/resource".into()],
        }];
        assert!(matches!(
            verify_option_resources(&actor, &options, None).await,
            Err(Error::Conflict(message))
                if message == "engine option resource was not produced by the launched engine"
        ));
        assert!(writes.lock().await.is_empty());
        actor.terminate().await.unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_second_unheld_resource_is_refused_without_partial_option_writes() {
        let directory = tempfile::tempdir().unwrap();
        let first_path = directory.path().join("first");
        std::fs::write(&first_path, b"first").unwrap();
        let first = Arc::new(
            crate::infra::path_authority::EngineResourceLease::test_file(
                std::fs::File::open(&first_path).unwrap(),
            ),
        );
        #[cfg(target_os = "macos")]
        first.pin_test_target_to_original().unwrap();
        let first_value = first.uci_value().unwrap();
        let (actor, writes) = EngineActor::recording_test_actor_with_resources(&[], vec![first]);
        assert_eq!(actor.resources.len(), 1);
        let first_verified = Arc::new(AtomicBool::new(false));
        let first_verified_for_hook = first_verified.clone();
        set_resource_verify_hook(
            first_value.clone(),
            Some(Box::new(move || {
                first_verified_for_hook.store(true, Ordering::SeqCst);
            })),
        );
        let options = [ResolvedEngineOption {
            name: "Tablebases".into(),
            value: format!("{first_value}:/second"),
            resources: Vec::new(),
            resource_values: vec![first_value.clone(), "/second".into()],
        }];
        let result = verify_option_resources(&actor, &options, None).await;
        set_resource_verify_hook(first_value, None);
        assert!(matches!(result, Err(Error::Conflict(_))));
        assert!(first_verified.load(Ordering::SeqCst));
        assert!(writes.lock().await.is_empty());
        actor.terminate().await.unwrap();
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn a_replaced_second_resource_is_refused_without_partial_option_writes() {
        let directory = tempfile::tempdir().unwrap();
        let first_path = directory.path().join("first");
        let second_path = directory.path().join("second");
        std::fs::create_dir(&first_path).unwrap();
        std::fs::create_dir(&second_path).unwrap();
        let first = Arc::new(
            crate::infra::path_authority::EngineResourceLease::test_directory(
                std::fs::File::open(&first_path).unwrap(),
            ),
        );
        let second = Arc::new(
            crate::infra::path_authority::EngineResourceLease::test_directory(
                std::fs::File::open(&second_path).unwrap(),
            ),
        );
        first.pin_test_target_to_original().unwrap();
        second.pin_test_target_to_original().unwrap();
        let first_value = first.uci_value().unwrap();
        let second_value = second.uci_value().unwrap();
        let (actor, writes) = EngineActor::recording_test_actor_with_resources(
            &[],
            vec![first.clone(), second.clone()],
        );
        std::fs::rename(&second_path, directory.path().join("second-original")).unwrap();
        std::fs::create_dir(&second_path).unwrap();
        let options = [ResolvedEngineOption {
            name: "Tablebases".into(),
            value: format!("{first_value}:{second_value}"),
            resources: vec![first, second],
            resource_values: vec![first_value, second_value],
        }];
        assert!(matches!(
            verify_option_resources(&actor, &options, None).await,
            Err(Error::Conflict(message))
                if message == "engine resource changed after authorization"
        ));
        assert!(writes.lock().await.is_empty());
        actor.terminate().await.unwrap();
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "current_thread")]
    async fn resolved_executable_stays_authorized_after_source_replacement_before_spawn() {
        let directory = tempfile::tempdir().unwrap();
        let script = directory.path().join("authorized-engine.sh");
        crate::infra::test_executable::publish_test_executable(
            &script,
            "#!/bin/sh\nwhile IFS= read -r line; do case \"$line\" in uci) echo uciok;; isready) echo readyok;; quit) exit 0;; esac; done\n", 0o700)
        .unwrap();
        let replacement = script.clone();
        let authority = PathAuthority::open_for_engine_test(directory.path()).unwrap();
        let mut authority = authority;
        let engine = authority
            .register_engine_file(&script, "authorized-engine")
            .unwrap();
        let authority = crate::infra::path_authority::SharedPathAuthority::installed(authority);
        let supervisor = Arc::new(EngineSupervisor::default());
        let key = EngineKey::new("replacement".into(), "authorized-engine".into()).unwrap();
        let admission = supervisor
            .admit_for_launch(key.clone(), "authorized-engine".into(), engine.id.clone())
            .await
            .unwrap();
        let replaced = Arc::new(AtomicBool::new(false));
        let replaced_in_hook = replaced.clone();
        ENGINE_LAUNCH_RESOLUTION_HOOKS.arm(
            key.clone(),
            Box::new(move || {
                std::fs::rename(&replacement, replacement.with_extension("replaced")).unwrap();
                std::fs::write(&replacement, "#!/bin/sh\nexit 22\n").unwrap();
                replaced_in_hook.store(true, AtomicOrdering::SeqCst);
            }),
        );
        let (executable, _) = resolve_launch(
            authority,
            engine,
            PathOperation::EngineExecute,
            &[],
            &admission,
        )
        .await
        .unwrap();
        ENGINE_LAUNCH_RESOLUTION_HOOKS.clear(&key);
        // Without this the test passes when the hook never fires at all: the unreplaced
        // executable starts either way, so a lost or miskeyed hook would look like a pass.
        assert!(
            replaced.load(AtomicOrdering::SeqCst),
            "the resolution hook armed for {key:?} never ran, so no replacement was staged"
        );

        let actor = EngineActor::spawn_initialized(executable, EngineDeadlines::default())
            .await
            .unwrap();
        actor.terminate().await.unwrap();
    }

    #[cfg(target_os = "macos")]
    #[tokio::test(flavor = "current_thread")]
    async fn resolve_launch_pins_file_resource_before_value_construction() {
        use crate::infra::path_authority::{
            EngineLaunchRoot, EngineResourceHandleKind, PathAuthority, PathClass,
            ENGINE_EXECUTABLE_LEAF_MODE, ENGINE_RESOURCE_LEAF_MODE,
        };
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().unwrap();
        let script = directory.path().join("resolve-launch-resource-engine.sh");
        crate::infra::test_executable::publish_test_executable(
            &script,
            "#!/bin/sh\nwhile IFS= read -r line; do case \"$line\" in uci) echo uciok;; isready) echo readyok;; setoption*) p=${line#*value }; cat \"$p\";; quit) exit 0;; esac; done\n", 0o555)
        .unwrap();
        let resource_path = directory.path().join("resource.bin");
        std::fs::write(&resource_path, b"authorized-resource\n").unwrap();
        std::fs::set_permissions(&resource_path, std::fs::Permissions::from_mode(0o444)).unwrap();
        let launch_root = EngineLaunchRoot::for_test(directory.path()).unwrap();
        let mut authority = PathAuthority::open_with_launch_root(
            directory.path().join("registry.json"),
            Vec::new(),
            launch_root.clone(),
        )
        .unwrap();
        let engine = authority
            .register_engine_file(&script, "resolve-launch-resource-engine")
            .unwrap();
        let grant = authority
            .grant_dialog(
                &resource_path,
                "resource",
                PathClass::SingleDialogGrant,
                PathOperation::EngineResourceRead,
                Duration::from_secs(30),
                1,
            )
            .unwrap();
        let resource = authority
            .promote_engine_resource(&grant, EngineResourceHandleKind::File, "resource")
            .unwrap();
        let authority = crate::infra::path_authority::SharedPathAuthority::installed(authority);
        let supervisor = Arc::new(EngineSupervisor::default());
        let key = EngineKey::new("resolve-launch-resource".into(), engine.id.id.clone()).unwrap();
        let admission = supervisor
            .admit_for_launch(
                key,
                "resolve-launch-resource-engine".into(),
                engine.id.clone(),
            )
            .await
            .unwrap();
        let (executable, resolved) = resolve_launch(
            authority,
            engine,
            PathOperation::EngineExecute,
            &[EngineOption::Resource {
                name: "EvalFile".into(),
                resources: vec![resource],
            }],
            &admission,
        )
        .await
        .unwrap();
        assert_eq!(resolved.len(), 1);
        let value = resolved[0].value.clone();
        assert!(value.starts_with(launch_root.instance_path().to_string_lossy().as_ref()));
        assert_ne!(value, resource_path.to_string_lossy());
        assert_eq!(
            std::fs::metadata(executable.command_target())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            ENGINE_EXECUTABLE_LEAF_MODE
        );
        assert_eq!(
            std::fs::metadata(&value).unwrap().permissions().mode() & 0o777,
            ENGINE_RESOURCE_LEAF_MODE
        );

        std::fs::rename(
            &resource_path,
            directory.path().join("resource-original.bin"),
        )
        .unwrap();
        std::fs::write(&resource_path, b"replacement-resource\n").unwrap();
        let actor = EngineActor::spawn_initialized(executable, EngineDeadlines::default())
            .await
            .unwrap();
        actor
            .set_option_with_resources("EvalFile", &value, std::slice::from_ref(&value))
            .await
            .unwrap();
        actor.ensure_ready().await.unwrap();
        let logs = actor.logs().await.unwrap();
        assert!(logs.iter().any(|entry| {
            matches!(entry, EngineLog::Engine(line) if line == "authorized-resource")
        }));
        assert!(!logs.iter().any(|entry| {
            matches!(entry, EngineLog::Engine(line) if line == "replacement-resource")
        }));
        actor.terminate().await.unwrap();
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "current_thread")]
    async fn earlier_duplicate_directory_replacement_is_ignored_when_effective_option_is_valid() {
        use crate::infra::path_authority::{EngineResourceHandleKind, PathAuthority, PathClass};

        let directory = tempfile::tempdir().unwrap();
        let script = directory.path().join("duplicate-directory-engine.sh");
        std::fs::write(&script, "#!/bin/sh\n").unwrap();
        #[cfg(target_os = "macos")]
        let launch_root =
            crate::infra::path_authority::EngineLaunchRoot::for_test(directory.path()).unwrap();
        let mut authority = {
            #[cfg(target_os = "macos")]
            {
                PathAuthority::open_with_launch_root(
                    directory.path().join("registry.json"),
                    Vec::new(),
                    launch_root.clone(),
                )
                .unwrap()
            }
            #[cfg(target_os = "linux")]
            {
                PathAuthority::open(directory.path().join("registry.json"), Vec::new()).unwrap()
            }
        };
        let engine = authority
            .register_engine_file(&script, "duplicate-directory-engine")
            .unwrap();
        let first_path = directory.path().join("first-tables");
        let second_path = directory.path().join("second-tables");
        std::fs::create_dir(&first_path).unwrap();
        std::fs::create_dir(&second_path).unwrap();
        let promote = |authority: &mut PathAuthority, path: &std::path::Path, name: &str| {
            let grant = authority
                .grant_dialog(
                    path,
                    name,
                    PathClass::SingleDialogGrant,
                    PathOperation::EngineResourceRead,
                    Duration::from_secs(30),
                    1,
                )
                .unwrap();
            authority
                .promote_engine_resource(&grant, EngineResourceHandleKind::Directory, name)
                .unwrap()
        };
        let first = promote(&mut authority, &first_path, "first-tables");
        let second = promote(&mut authority, &second_path, "second-tables");
        std::fs::remove_dir(&first_path).unwrap();
        std::fs::write(&first_path, b"replaced").unwrap();

        let authority = crate::infra::path_authority::SharedPathAuthority::installed(authority);
        let supervisor = Arc::new(EngineSupervisor::default());
        let key = EngineKey::new("duplicate-directory".into(), engine.id.id.clone()).unwrap();
        let admission = supervisor
            .admit_for_launch(key, "duplicate-directory-engine".into(), engine.id.clone())
            .await
            .unwrap();
        let result = resolve_launch(
            authority,
            engine,
            PathOperation::EngineExecute,
            &[
                EngineOption::Resource {
                    name: "SyzygyPath".into(),
                    resources: vec![first],
                },
                EngineOption::Resource {
                    name: "SyzygyPath".into(),
                    resources: vec![second],
                },
            ],
            &admission,
        )
        .await;
        let (executable, resolved) = result.unwrap();
        assert_eq!(resolved.len(), 1);
        assert_eq!(resolved[0].resources.len(), 1);
        drop(executable);
        #[cfg(target_os = "macos")]
        assert!(launch_root.reclaim().removed >= 1);
    }

    #[cfg(target_os = "macos")]
    #[tokio::test(flavor = "current_thread")]
    async fn duplicate_evalfile_options_use_only_the_effective_resources_for_leaf_capacity() {
        use crate::infra::path_authority::{
            EngineLaunchRoot, EngineResourceHandleKind, PathAuthority, PathClass,
        };

        let directory = tempfile::tempdir().unwrap();
        let script = directory.path().join("duplicate-evalfile-engine.sh");
        std::fs::write(&script, "#!/bin/sh\n").unwrap();
        let launch_root = EngineLaunchRoot::for_test(directory.path()).unwrap();
        let mut authority = PathAuthority::open_with_launch_root(
            directory.path().join("registry.json"),
            Vec::new(),
            launch_root.clone(),
        )
        .unwrap();
        let engine = authority
            .register_engine_file(&script, "duplicate-evalfile-engine")
            .unwrap();
        let mut resources = Vec::new();
        for index in 0..64 {
            let path = directory.path().join(format!("resource-{index}.bin"));
            std::fs::write(&path, index.to_string()).unwrap();
            let grant = authority
                .grant_dialog(
                    &path,
                    format!("resource-{index}"),
                    PathClass::SingleDialogGrant,
                    PathOperation::EngineResourceRead,
                    Duration::from_secs(30),
                    1,
                )
                .unwrap();
            resources.push(
                authority
                    .promote_engine_resource(
                        &grant,
                        EngineResourceHandleKind::File,
                        format!("resource-{index}"),
                    )
                    .unwrap(),
            );
        }
        let first = resources[..32].to_vec();
        let second = resources[32..].to_vec();
        let authority = crate::infra::path_authority::SharedPathAuthority::installed(authority);
        let supervisor = Arc::new(EngineSupervisor::default());
        let key = EngineKey::new("duplicate-evalfile".into(), engine.id.id.clone()).unwrap();
        let admission = supervisor
            .admit_for_launch(key, "duplicate-evalfile-engine".into(), engine.id.clone())
            .await
            .unwrap();
        let (executable, resolved) = resolve_launch(
            authority,
            engine,
            PathOperation::EngineExecute,
            &[
                EngineOption::Resource {
                    name: "EvalFile".into(),
                    resources: first,
                },
                EngineOption::Resource {
                    name: "EvalFile".into(),
                    resources: second,
                },
            ],
            &admission,
        )
        .await
        .unwrap();
        assert_eq!(resolved.len(), 1);
        assert_eq!(resolved[0].resources.len(), 32);
        assert_eq!(launch_root.registry_snapshot_for_test().0, 33);
        drop(executable);
        assert_eq!(launch_root.reclaim().removed, 33);
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "current_thread")]
    async fn launch_resolution_and_materialization_run_off_the_async_caller() {
        use crate::infra::path_authority::{EngineResourceHandleKind, PathAuthority, PathClass};
        use std::thread::ThreadId;

        let directory = tempfile::tempdir().unwrap();
        let script = directory.path().join("thread-engine.sh");
        std::fs::write(&script, "#!/bin/sh\n").unwrap();
        let resource_path = directory.path().join("thread-resource.bin");
        std::fs::write(&resource_path, b"resource").unwrap();
        let root = std::thread::current().id();
        let trace = Arc::new(std::sync::Mutex::new(Vec::<(&'static str, ThreadId)>::new()));
        crate::infra::path_authority::set_engine_resolution_trace(Some(trace.clone()));
        let mut authority = PathAuthority::open_for_engine_test(directory.path()).unwrap();
        let engine = authority
            .register_engine_file(&script, "thread-engine")
            .unwrap();
        let grant = authority
            .grant_dialog(
                &resource_path,
                "thread-resource",
                PathClass::SingleDialogGrant,
                PathOperation::EngineResourceRead,
                Duration::from_secs(30),
                1,
            )
            .unwrap();
        let resource = authority
            .promote_engine_resource(&grant, EngineResourceHandleKind::File, "thread-resource")
            .unwrap();
        #[cfg(target_os = "macos")]
        let launch_root = authority.engine_launch_root().unwrap();
        let authority = crate::infra::path_authority::SharedPathAuthority::installed(authority);
        let supervisor = Arc::new(EngineSupervisor::default());
        let key = EngineKey::new("thread-test".into(), "thread-engine".into()).unwrap();
        let admission = supervisor
            .admit_for_launch(key, "thread-engine".into(), engine.id.clone())
            .await
            .unwrap();
        let result = resolve_launch(
            authority,
            engine,
            PathOperation::EngineExecute,
            &[EngineOption::Resource {
                name: "EvalFile".into(),
                resources: vec![resource],
            }],
            &admission,
        )
        .await;
        crate::infra::path_authority::set_engine_resolution_trace(None);
        let (executable, _) = result.unwrap();
        let trace = trace.lock().unwrap().clone();
        #[cfg(target_os = "linux")]
        let expected = vec!["executable", "resource"];
        #[cfg(target_os = "macos")]
        let expected = vec!["executable", "resource", "leaf", "leaf"];
        assert_eq!(
            trace.iter().map(|(kind, _)| *kind).collect::<Vec<_>>(),
            expected
        );
        assert!(trace.iter().all(|(_, thread)| *thread != root));
        #[cfg(target_os = "macos")]
        {
            drop(executable);
            assert!(launch_root.reclaim().removed >= 1);
        }
        #[cfg(target_os = "linux")]
        drop(executable);
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn launch_without_an_initialized_root_is_refused_before_spawn() {
        use crate::infra::path_authority::PathAuthority;
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().unwrap();
        let script = directory.path().join("missing-launch-root-engine.sh");
        std::fs::write(&script, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
        let mut authority =
            PathAuthority::open(directory.path().join("registry.json"), Vec::new()).unwrap();
        let engine = authority
            .register_engine_file(&script, "missing-root-engine")
            .unwrap();
        let authority = crate::infra::path_authority::SharedPathAuthority::installed(authority);
        let supervisor = Arc::new(EngineSupervisor::default());
        let key = EngineKey::new("missing-root".into(), "missing-root-engine".into()).unwrap();
        let admission = supervisor
            .admit_for_launch(key, "missing-root-engine".into(), engine.id.clone())
            .await
            .unwrap();
        assert!(matches!(
            resolve_launch(
                authority,
                engine,
                PathOperation::EngineExecute,
                &[],
                &admission,
            )
            .await,
            Err(Error::Conflict(message))
                if message == "engine launch root is not initialized"
        ));
    }

    #[cfg(target_os = "macos")]
    #[tokio::test(flavor = "current_thread")]
    async fn launch_reports_a_failed_prior_reclaim_with_engine_identity() {
        use crate::error::LogCaptureScope;
        use crate::infra::path_authority::{EngineLaunchRoot, PathAuthority};
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("source");
        std::fs::write(&source, b"released").unwrap();
        let launch_root = EngineLaunchRoot::for_test(directory.path()).unwrap();
        let mut released = launch_root
            .reserve_leaves(1, "stale-tab:stale-engine", "stale-engine")
            .unwrap()
            .pop()
            .unwrap();
        released
            .create_from(
                &std::fs::File::open(&source).unwrap(),
                crate::infra::path_authority::ENGINE_RESOURCE_LEAF_MODE,
                &|| false,
            )
            .unwrap();
        drop(released);

        let script = directory.path().join("reclaim-log-engine.sh");
        std::fs::write(&script, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
        let mut authority = PathAuthority::open_with_launch_root(
            directory.path().join("registry.json"),
            Vec::new(),
            launch_root.clone(),
        )
        .unwrap();
        let engine = authority
            .register_engine_file(&script, "reclaim-log-engine")
            .unwrap();
        let authority = crate::infra::path_authority::SharedPathAuthority::installed(authority);
        let supervisor = Arc::new(EngineSupervisor::default());
        let key = EngineKey::new("reclaim-log-tab".into(), "reclaim-log-engine".into()).unwrap();
        let admission = supervisor
            .admit_for_launch(key, "reclaim-log-engine".into(), engine.id.clone())
            .await
            .unwrap();
        crate::infra::fs::set_test_removal_injector(Some(Arc::new(
            crate::infra::fs::RemovalFault(crate::infra::fs::RemovalFaultPoint::BeforeTopOpen),
        )));
        let capture = LogCaptureScope::start();
        let result = resolve_launch(
            authority,
            engine,
            PathOperation::EngineExecute,
            &[],
            &admission,
        )
        .await;
        crate::infra::fs::set_test_removal_injector(None);
        let (executable, _) = result.unwrap();
        assert!(capture.messages().iter().any(|message| {
            message.contains(
                "engine launch leaf reclaim failed for key=stale-tab:stale-engine \
engine_id=stale-engine category=I/O failure",
            )
        }));
        drop(executable);
        assert_eq!(launch_root.reclaim().removed, 2);
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn launch_value_construction_failure_releases_pinned_leaves() {
        use crate::infra::path_authority::PathAuthority;
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().unwrap();
        let script = directory.path().join("value-failure-engine.sh");
        std::fs::write(&script, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
        let root =
            crate::infra::path_authority::EngineLaunchRoot::for_test(directory.path()).unwrap();
        let mut authority = PathAuthority::open_with_launch_root(
            directory.path().join("registry.json"),
            Vec::new(),
            root.clone(),
        )
        .unwrap();
        let engine = authority
            .register_engine_file(&script, "value-failure-engine")
            .unwrap();
        let authority = crate::infra::path_authority::SharedPathAuthority::installed(authority);
        let supervisor = Arc::new(EngineSupervisor::default());
        let key = EngineKey::new("value-failure".into(), "value-failure-engine".into()).unwrap();
        let admission = supervisor
            .admit_for_launch(
                key.clone(),
                "value-failure-engine".into(),
                engine.id.clone(),
            )
            .await
            .unwrap();
        ENGINE_LAUNCH_VALUE_FAILURES.arm(key.clone(), ());
        let result = resolve_launch(
            authority,
            engine,
            PathOperation::EngineExecute,
            &[],
            &admission,
        )
        .await;
        ENGINE_LAUNCH_VALUE_FAILURES.clear(&key);
        assert!(matches!(
            result,
            Err(Error::Conflict(message))
                if message == "injected engine launch value construction failure"
        ));
        assert_eq!(root.registry_snapshot_for_test().0, 1);
        assert_eq!(root.reclaim().removed, 1);
    }

    #[cfg(target_os = "macos")]
    #[tokio::test(flavor = "current_thread")]
    async fn launch_pin_operation_and_cleanup_failure_logs_both_categories() {
        use crate::error::LogCaptureScope;
        use crate::infra::fs::{RemovalFault, RemovalFaultPoint};
        use crate::infra::path_authority::{EngineLaunchFailure, EngineLaunchRoot, PathAuthority};
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().unwrap();
        let script = directory.path().join("pin-failure-engine.sh");
        std::fs::write(&script, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
        let root = EngineLaunchRoot::for_test(directory.path()).unwrap();
        let mut authority = PathAuthority::open_with_launch_root(
            directory.path().join("registry.json"),
            Vec::new(),
            root.clone(),
        )
        .unwrap();
        let engine = authority
            .register_engine_file(&script, "pin-failure-engine")
            .unwrap();
        let authority = crate::infra::path_authority::SharedPathAuthority::installed(authority);
        let supervisor = Arc::new(EngineSupervisor::default());
        let key = EngineKey::new("pin-failure".into(), "pin-failure-engine".into()).unwrap();
        let admission = supervisor
            .admit_for_launch(key.clone(), "pin-failure-engine".into(), engine.id.clone())
            .await
            .unwrap();

        crate::infra::path_authority::set_engine_launch_failure(
            &engine_launch_key(&key),
            Some(EngineLaunchFailure::Fchmod),
        );
        crate::infra::fs::set_test_removal_injector(Some(Arc::new(RemovalFault(
            RemovalFaultPoint::BeforeTopOpen,
        ))));
        let capture = LogCaptureScope::start();
        let result = resolve_launch(
            authority,
            engine,
            PathOperation::EngineExecute,
            &[],
            &admission,
        )
        .await;
        crate::infra::path_authority::set_engine_launch_failure(&engine_launch_key(&key), None);
        crate::infra::fs::set_test_removal_injector(None);

        assert!(matches!(result, Err(Error::OperationAndCleanup { .. })));
        assert!(capture.messages().iter().any(|message| {
            message.contains(
                "engine launch pin failed for key=pin-failure:pin-failure-engine \
engine_id=pin-failure-engine primary_category=I/O failure cleanup_category=I/O failure",
            )
        }));
        let (live, released) = root.registry_snapshot_for_test();
        assert_eq!(live, 1);
        assert_eq!(released.len(), 1);
        assert_eq!(root.reclaim().removed, 1);
        assert_eq!(root.registry_snapshot_for_test().0, 0);
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn cancellation_after_pinning_releases_leaves_before_spawn() {
        use crate::infra::path_authority::PathAuthority;
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().unwrap();
        let script = directory.path().join("post-pin-cancel-engine.sh");
        std::fs::write(&script, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
        let root =
            crate::infra::path_authority::EngineLaunchRoot::for_test(directory.path()).unwrap();
        let mut authority = PathAuthority::open_with_launch_root(
            directory.path().join("registry.json"),
            Vec::new(),
            root.clone(),
        )
        .unwrap();
        let engine = authority
            .register_engine_file(&script, "post-pin-cancel-engine")
            .unwrap();
        let authority = crate::infra::path_authority::SharedPathAuthority::installed(authority);
        let supervisor = Arc::new(EngineSupervisor::default());
        let key =
            EngineKey::new("post-pin-cancel".into(), "post-pin-cancel-engine".into()).unwrap();
        let admission = supervisor
            .admit_for_launch(
                key.clone(),
                "post-pin-cancel-engine".into(),
                engine.id.clone(),
            )
            .await
            .unwrap();
        let cancelled = admission.admission.cancelled.clone();
        ENGINE_LAUNCH_POST_PIN_HOOKS.arm(
            key.clone(),
            Box::new(move || {
                cancelled.store(true, AtomicOrdering::SeqCst);
            }),
        );
        let result = resolve_launch(
            authority,
            engine,
            PathOperation::EngineExecute,
            &[],
            &admission,
        )
        .await;
        ENGINE_LAUNCH_POST_PIN_HOOKS.clear(&key);
        assert!(matches!(result, Err(Error::Cancellation)));
        assert_eq!(root.registry_snapshot_for_test().0, 1);
        assert_eq!(root.reclaim().removed, 1);
        assert!(supervisor
            .get_exact(
                &EngineKey::new("post-pin-cancel".into(), "post-pin-cancel-engine".into()).unwrap()
            )
            .is_none());
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn child_io_take_failures_release_pinned_leaves_after_spawn() {
        for failure in [SpawnIoFailure::NoStdin, SpawnIoFailure::NoStdout] {
            let directory = tempfile::tempdir().unwrap();
            let script = directory.path().join("io-failure-engine.sh");
            crate::infra::test_executable::publish_test_executable(
                &script,
                "#!/bin/sh\nwhile IFS= read -r line; do :; done\n",
                0o700,
            )
            .unwrap();
            let root =
                crate::infra::path_authority::EngineLaunchRoot::for_test(directory.path()).unwrap();
            let mut executable = EngineExecutable::test_fixture(
                std::fs::File::open(&script).unwrap(),
                directory.path().to_path_buf(),
                Vec::new(),
            );
            executable.set_test_launch_root(root.clone());
            let key = EngineKey::new("io-failure".into(), "io-failure-engine".into()).unwrap();
            pin_engine_launch(&mut executable, &key, "io-failure-engine", &|| false).unwrap();
            set_spawn_io_failure(Some(failure));
            let result = EngineActor::spawn(executable, EngineDeadlines::default()).await;
            match failure {
                SpawnIoFailure::NoStdin => assert!(matches!(result, Err(Error::NoStdin))),
                SpawnIoFailure::NoStdout => assert!(matches!(result, Err(Error::NoStdout))),
            }
            set_spawn_io_failure(None);
            assert_eq!(root.registry_snapshot_for_test().0, 1);
            assert_eq!(root.reclaim().removed, 1);
        }
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn apple_fallback_materializes_and_runs_the_authorized_engine_image() {
        use crate::infra::path_authority::EngineLaunchFailure;

        for failure in [
            EngineLaunchFailure::CloneExdev,
            EngineLaunchFailure::CloneEnotsup,
        ] {
            let directory = tempfile::tempdir().unwrap();
            let script = directory.path().join("fallback-engine.sh");
            crate::infra::test_executable::publish_test_executable(
                &script,
                "#!/bin/sh\nwhile IFS= read -r line; do case \"$line\" in uci) echo uciok;; isready) echo readyok;; quit) exit 0;; esac; done\n", 0o700)
            .unwrap();
            let root =
                crate::infra::path_authority::EngineLaunchRoot::for_test(directory.path()).unwrap();
            let mut executable = EngineExecutable::test_fixture(
                std::fs::File::open(&script).unwrap(),
                directory.path().to_path_buf(),
                Vec::new(),
            );
            executable.set_test_launch_root(root.clone());
            let key = EngineKey::new("fallback".into(), "fallback-engine".into()).unwrap();
            crate::infra::path_authority::set_engine_launch_failure(
                &engine_launch_key(&key),
                Some(failure),
            );
            pin_engine_launch(&mut executable, &key, "fallback-engine", &|| false).unwrap();
            crate::infra::path_authority::set_engine_launch_failure(&engine_launch_key(&key), None);
            std::fs::rename(&script, directory.path().join("authorized-original.sh")).unwrap();
            std::fs::write(&script, "#!/bin/sh\nexit 22\n").unwrap();
            let actor = EngineActor::spawn_initialized(executable, EngineDeadlines::default())
                .await
                .unwrap();
            actor.terminate().await.unwrap();
            assert_eq!(root.reclaim().removed, 1);
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn real_child_termination_failures_cover_error_and_timeout_reap_branches() {
        for (failure, expected_timeout) in [
            (TerminateFailure::QuitKillReap, false),
            (TerminateFailure::ReapTimeout, true),
        ] {
            let directory = tempfile::tempdir().unwrap();
            let executable = stdin_waiting_observer_executable(&directory);
            let deadlines = EngineDeadlines {
                quit: Duration::from_millis(20),
                kill_reap: Duration::from_millis(30),
                ..EngineDeadlines::default()
            };
            let command_target = executable.command_target().to_path_buf();
            let (pid_tx, pid_rx) = std::sync::mpsc::channel();
            let _observer = set_spawn_child_observer(
                command_target,
                Box::new(move |pid| {
                    let _ = pid_tx.send(pid);
                }),
            );
            set_terminate_failure(Some(failure));
            let result = EngineRuntime::spawn(executable, deadlines).await;
            set_terminate_failure(None);
            let pid = child_pid_published_when_spawn_completed(&pid_rx, &result);
            let mut runtime = result.expect("termination-failure child must spawn");
            let result = runtime.terminate().await;
            if expected_timeout {
                assert!(matches!(result, Err(Error::EngineTimeout(_))));
            } else {
                assert!(matches!(result, Err(Error::OperationAndCleanup { .. })));
            }
            drop(runtime);
            if !expected_timeout {
                assert_child_is_reaped(pid);
            }
        }
    }

    #[cfg(target_os = "macos")]
    #[tokio::test(flavor = "current_thread")]
    async fn apple_directory_resource_replacement_is_refused_before_setoption() {
        let directory = tempfile::tempdir().unwrap();
        let tables = directory.path().join("tables");
        std::fs::create_dir(&tables).unwrap();
        std::fs::write(tables.join("authorized"), b"authorized").unwrap();
        let lease = Arc::new(
            crate::infra::path_authority::EngineResourceLease::test_directory(
                std::fs::File::open(&tables).unwrap(),
            ),
        );
        let value = lease.uci_value().unwrap();
        let (actor, writes) = EngineActor::recording_test_actor_with_resources(&[], vec![lease]);
        std::fs::rename(&tables, directory.path().join("tables-original")).unwrap();
        std::fs::create_dir(&tables).unwrap();
        std::fs::write(tables.join("replacement"), b"replacement").unwrap();
        let options = [ResolvedEngineOption {
            name: "SyzygyPath".into(),
            value: value.clone(),
            resources: Vec::new(),
            resource_values: vec![value],
        }];
        assert!(matches!(
            verify_option_resources(&actor, &options, None).await,
            Err(Error::Conflict(message))
                if message == "engine resource changed after authorization"
        ));
        assert!(writes.lock().await.is_empty());
        actor.terminate().await.unwrap();
    }

    #[cfg(target_os = "macos")]
    #[tokio::test(flavor = "current_thread")]
    async fn apple_directory_resource_removal_and_file_swap_are_refused_before_setoption() {
        for replacement in ["remove", "file"] {
            let directory = tempfile::tempdir().unwrap();
            let script = directory.path().join("directory-check-engine.sh");
            crate::infra::test_executable::publish_test_executable(
                &script,
                "#!/bin/sh\nwhile IFS= read -r line; do case \"$line\" in uci) echo uciok;; isready) echo readyok;; setoption*) echo setoption-unexpected;; quit) exit 0;; esac; done\n", 0o700)
            .unwrap();
            let tables = directory.path().join("tables");
            std::fs::create_dir(&tables).unwrap();
            std::fs::write(tables.join("authorized"), b"authorized").unwrap();
            let resource = Arc::new(
                crate::infra::path_authority::EngineResourceLease::test_directory(
                    std::fs::File::open(&tables).unwrap(),
                ),
            );
            let value = resource.uci_value().unwrap();
            let root =
                crate::infra::path_authority::EngineLaunchRoot::for_test(directory.path()).unwrap();
            let mut executable = EngineExecutable::test_fixture(
                std::fs::File::open(&script).unwrap(),
                directory.path().to_path_buf(),
                Vec::new(),
            )
            .with_resource_leases(vec![resource.clone()]);
            executable.set_test_launch_root(root);
            let key =
                EngineKey::new("directory-check".into(), "directory-check-engine".into()).unwrap();
            pin_engine_launch(&mut executable, &key, "directory-check-engine", &|| false).unwrap();
            let actor = EngineActor::spawn_initialized(executable, EngineDeadlines::default())
                .await
                .unwrap();
            if replacement == "remove" {
                std::fs::remove_dir_all(&tables).unwrap();
            } else {
                std::fs::remove_dir_all(&tables).unwrap();
                std::fs::write(&tables, b"replacement-file").unwrap();
            }
            let options = [ResolvedEngineOption {
                name: "SyzygyPath".into(),
                value: value.clone(),
                resources: vec![resource],
                resource_values: vec![value],
            }];
            assert!(matches!(
                verify_option_resources(&actor, &options, None).await,
                Err(Error::Conflict(message))
                    if message == "engine resource changed after authorization"
            ));
            assert!(actor.logs().await.unwrap().iter().all(|entry| match entry {
                EngineLog::Gui(line) | EngineLog::Engine(line) => {
                    !line.contains("setoption")
                }
                EngineLog::Truncated { .. } => true,
            }));
            actor.terminate().await.unwrap();
        }
    }
}
