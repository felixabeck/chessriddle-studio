//! Bounded engine transcripts, resource-path redaction and terminal diagnostics.

use super::*;

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
    pub(super) fn byte_len(&self) -> usize {
        match self {
            Self::Gui(line) | Self::Engine(line) => line.len(),
            Self::Truncated { .. } => 0,
        }
    }
}

#[derive(Debug, Default)]
pub(super) struct BoundedLogs {
    pub(super) entries: VecDeque<EngineLog>,
    pub(super) bytes: usize,
    pub(super) truncated: bool,
    pub(super) dropped_entries: u64,
}

impl BoundedLogs {
    pub(super) fn push(&mut self, entry: EngineLog) {
        // A pathological single UCI line must not turn the bounded log into an
        // unbounded allocation. It is retained with a visible suffix before
        // accounting, so it does not unnecessarily evict the whole transcript.
        let (entry, was_truncated) = normalize_log_entry(entry);
        self.truncated |= was_truncated;
        self.evict_for(entry.byte_len(), true);
        self.bytes += entry.byte_len();
        self.entries.push_back(entry);
    }

    pub(super) fn entries(&self) -> Vec<EngineLog> {
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

    pub(super) fn redact(&mut self, values: &[String]) {
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

    pub(super) fn evict_for(&mut self, incoming_bytes: usize, reserve_slot: bool) {
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

pub(super) fn normalize_log_entry(entry: EngineLog) -> (EngineLog, bool) {
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

pub(super) fn redact_line(mut line: String, values: &[String]) -> String {
    for value in values {
        line = line.replace(value, "[redacted]");
    }
    line
}

#[derive(Debug, Default)]
pub(super) struct ResourceRedactions {
    pub(super) values: Vec<String>,
    pub(super) bytes: usize,
}

impl ResourceRedactions {
    pub(super) fn register(
        &mut self,
        values: &[String],
        logs: &mut BoundedLogs,
    ) -> Result<(), Error> {
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

    pub(super) fn redact(&self, line: String) -> String {
        redact_line(line, &self.values)
    }
}

pub(super) fn truncate_utf8(value: &mut String, max_bytes: usize) {
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
pub(super) struct TerminalDiagnostics {
    pub(super) entries: VecDeque<EngineTerminalEntry>,
    pub(super) resource_values: Vec<String>,
    pub(super) dropped: bool,
    pub(super) last_info: Option<String>,
    pub(super) last_stderr: Option<String>,
}

impl TerminalDiagnostics {
    pub(super) fn register(&mut self, values: &[String]) {
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

    pub(super) fn push(&mut self, text: &str, info: bool) {
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

    pub(super) fn evict(&mut self) {
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

    pub(super) fn entries(&self) -> Vec<EngineTerminalEntry> {
        let mut entries = Vec::with_capacity(self.entries.len() + usize::from(self.dropped));
        if self.dropped {
            entries.push(EngineTerminalEntry::Truncated);
        }
        entries.extend(self.entries.iter().cloned());
        entries
    }

    pub(super) fn snapshot(
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
pub(super) struct TerminalQuotedToken {
    pub(super) quote: u8,
    pub(super) start: usize,
    pub(super) close: Option<usize>,
    pub(super) end: usize,
}

// JSON wrapping changes delimiter escape depth. Only the exact opening depth
// can close a token. Other depths are ambiguous and remain literal content.
pub(super) fn terminal_quoted_token(text: &str, at: usize) -> Option<TerminalQuotedToken> {
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
pub(super) fn sanitize_terminal_text(text: &str) -> String {
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
