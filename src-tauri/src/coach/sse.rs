//! Server-sent events, as the model providers stream them.
//!
//! One decoder for every backend: it accepts the body in arbitrary chunks, understands `\n` and
//! `\r\n` line ends, ignores comment lines and fields other than `data`, and bounds the size of a
//! line and of an event so a hostile or broken stream cannot grow memory without limit.

use std::collections::VecDeque;

use tokio_util::sync::CancellationToken;

use super::error::CoachError;

/// The largest line, and the largest event payload, a stream may carry.
pub(crate) const MAX_SSE_BYTES: usize = 1 << 20;

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum SseError {
    /// A line or an event's payload exceeds [`MAX_SSE_BYTES`].
    TooLarge,
    InvalidUtf8,
}

/// Turns body chunks into the `data` payloads of complete events.
#[derive(Default)]
pub(crate) struct SseDecoder {
    line: Vec<u8>,
    data: String,
    has_data: bool,
}

impl SseDecoder {
    /// Feeds one chunk and appends the payload of every event it completes to `events`.
    pub(crate) fn push(
        &mut self,
        chunk: &[u8],
        events: &mut VecDeque<String>,
    ) -> Result<(), SseError> {
        for &byte in chunk {
            if byte != b'\n' {
                if self.line.len() >= MAX_SSE_BYTES {
                    return Err(SseError::TooLarge);
                }
                self.line.push(byte);
                continue;
            }
            let mut line = std::mem::take(&mut self.line);
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            self.accept_line(&line, events)?;
        }
        Ok(())
    }

    fn accept_line(&mut self, line: &[u8], events: &mut VecDeque<String>) -> Result<(), SseError> {
        if line.is_empty() {
            if self.has_data {
                events.push_back(std::mem::take(&mut self.data));
                self.has_data = false;
            }
            return Ok(());
        }
        let Some(value) = line.strip_prefix(b"data:") else {
            // Comments (`:`) and the fields `event`, `id` and `retry` carry nothing we use.
            return Ok(());
        };
        let value = value.strip_prefix(b" ").unwrap_or(value);
        let value = std::str::from_utf8(value).map_err(|_| SseError::InvalidUtf8)?;
        let separator = usize::from(self.has_data);
        if self.data.len() + separator + value.len() > MAX_SSE_BYTES {
            return Err(SseError::TooLarge);
        }
        if self.has_data {
            self.data.push('\n');
        }
        self.data.push_str(value);
        self.has_data = true;
        Ok(())
    }
}

/// The events of one streaming response.
pub(crate) struct SseStream {
    response: reqwest::Response,
    decoder: SseDecoder,
    events: VecDeque<String>,
}

impl SseStream {
    pub(crate) fn new(response: reqwest::Response) -> Self {
        Self {
            response,
            decoder: SseDecoder::default(),
            events: VecDeque::new(),
        }
    }

    /// The next event's payload, or `None` at the end of the body. An event the stream did not
    /// terminate with a blank line is not delivered. Cancellation ends the read at once.
    pub(crate) async fn next(
        &mut self,
        cancellation: &CancellationToken,
    ) -> Result<Option<String>, CoachError> {
        loop {
            if let Some(event) = self.events.pop_front() {
                return Ok(Some(event));
            }
            let chunk = tokio::select! {
                biased;
                () = cancellation.cancelled() => return Err(CoachError::Cancelled),
                chunk = self.response.chunk() => chunk.map_err(|error| super::http::transport_error(&error))?,
            };
            let Some(chunk) = chunk else {
                return Ok(None);
            };
            self.decoder
                .push(&chunk, &mut self.events)
                .map_err(|_| CoachError::ProviderFailure)?;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decode(chunks: &[&[u8]]) -> Result<Vec<String>, SseError> {
        let mut decoder = SseDecoder::default();
        let mut events = VecDeque::new();
        for chunk in chunks {
            decoder.push(chunk, &mut events)?;
        }
        Ok(events.into())
    }

    #[test]
    fn events_survive_any_chunking_and_both_line_ends() {
        let body = b"data: {\"a\":1}\n\ndata: second\r\n\r\ndata:third\n\n";
        let whole = decode(&[body]).unwrap();
        assert_eq!(whole, ["{\"a\":1}", "second", "third"]);
        for split in 1..body.len() {
            let (head, tail) = body.split_at(split);
            assert_eq!(decode(&[head, tail]).unwrap(), whole, "split at {split}");
        }
        let bytes: Vec<&[u8]> = body.chunks(1).collect();
        assert_eq!(decode(&bytes).unwrap(), whole);
    }

    #[test]
    fn comments_and_other_fields_are_ignored_and_data_lines_join() {
        let events = decode(&[
            b": OPENROUTER PROCESSING\n\nevent: response.created\nid: 7\nretry: 5\ndata: one\ndata: two\n\n:\n\n",
        ])
        .unwrap();
        assert_eq!(events, ["one\ntwo"]);
    }

    #[test]
    fn an_event_without_its_blank_line_is_not_delivered() {
        assert!(decode(&[b"data: cut off\n"]).unwrap().is_empty());
        assert!(decode(&[b"data: cut off"]).unwrap().is_empty());
    }

    #[test]
    fn an_oversized_line_or_event_is_refused() {
        let line = vec![b'x'; MAX_SSE_BYTES + 1];
        assert_eq!(decode(&[&line]), Err(SseError::TooLarge));

        let mut decoder = SseDecoder::default();
        let mut events = VecDeque::new();
        let half = format!("data: {}\n", "y".repeat(MAX_SSE_BYTES / 2));
        decoder.push(half.as_bytes(), &mut events).unwrap();
        assert_eq!(
            decoder.push(half.as_bytes(), &mut events),
            Err(SseError::TooLarge)
        );
    }

    #[test]
    fn invalid_utf8_in_a_payload_is_refused() {
        assert_eq!(decode(&[b"data: \xff\xfe\n\n"]), Err(SseError::InvalidUtf8));
    }
}
