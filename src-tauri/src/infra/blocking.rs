use crate::error::Error;
use once_cell::sync::Lazy;
use std::any::Any;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::Arc;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio_util::sync::CancellationToken;

/// Bounds the number of concurrently running production blocking tasks.
const BLOCKING_GATEWAY_PERMITS: usize = 4;

#[cfg(not(test))]
pub static BLOCKING_GATEWAY: Lazy<BlockingGateway> =
    Lazy::new(|| BlockingGateway::new(BLOCKING_GATEWAY_PERMITS));

#[cfg(test)]
pub static BLOCKING_GATEWAY: Lazy<BlockingGateway> = Lazy::new(BlockingGateway::per_thread);

/// No closure passed to BLOCKING_GATEWAY may, directly or transitively, call BLOCKING_GATEWAY
/// again. Acquiring several permits in sequence from an async body is fine; acquiring one inside
/// another is the deadlock.
///
/// `list_file_workspace_core` awaits `count_pgn_games_core`, which awaits `scan_current`
/// (`pgn.rs`), which takes a permit — that is a legal sequential acquisition and must not
/// become a nested one.
///
/// In the shipped app the gateway is one process-wide semaphore of `BLOCKING_GATEWAY_PERMITS`
/// (4) permits, so four nested acquisitions hang the process with no error. Test builds admit
/// against four permits owned by the OS thread that awaits admission, so a test saturates only
/// its own thread's capacity.
pub struct BlockingGateway {
    semaphore: GatewaySemaphore,
}

enum GatewaySemaphore {
    Explicit(Arc<Semaphore>),
    #[cfg(test)]
    PerThread,
}

#[cfg(test)]
thread_local! {
    static THREAD_GATEWAY: Arc<Semaphore> = Arc::new(Semaphore::new(BLOCKING_GATEWAY_PERMITS));
}

/// Source-text scanning shared by the blocking-offload invariant tests in `main.rs`, `chess.rs`,
/// `engine/process.rs`, `fs.rs`, `infra/fs.rs`, `infra/path_authority/mod.rs`,
/// `infra/platform_support/tests.rs` and `sound.rs`. It lives here, beside the non-nesting rule it
/// exists to prove, and there is exactly one copy on purpose: all scans depend on the same
/// delimiter list, so a private second copy would let an edit to one (a new `fn` prefix,
/// attribute placement, CRLF) silently change what the other treats as a function body.
#[cfg(test)]
pub(crate) mod source_scan {
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub(crate) enum Literals {
        Blank,
        Keep,
    }

    fn blank(bytes: &mut [u8], start: usize, end: usize) {
        for byte in &mut bytes[start..end] {
            if *byte != b'\n' {
                *byte = b' ';
            }
        }
    }

    fn raw_open(bytes: &[u8], start: usize) -> Option<(usize, usize)> {
        let hash_start = if bytes.get(start) == Some(&b'r') {
            start + 1
        } else if bytes.get(start) == Some(&b'b') && bytes.get(start + 1) == Some(&b'r') {
            start + 2
        } else {
            return None;
        };
        let mut cursor = hash_start;
        while bytes.get(cursor) == Some(&b'#') {
            cursor += 1;
        }
        (bytes.get(cursor) == Some(&b'"')).then_some((cursor + 1, cursor - hash_start))
    }

    fn raw_end(bytes: &[u8], content_start: usize, hashes: usize) -> Option<usize> {
        let mut cursor = content_start;
        while cursor < bytes.len() {
            if bytes[cursor] == b'"'
                && bytes
                    .get(cursor + 1..cursor + 1 + hashes)
                    .is_some_and(|suffix| suffix.iter().all(|byte| *byte == b'#'))
            {
                return Some(cursor + 1 + hashes);
            }
            cursor += 1;
        }
        None
    }

    fn quoted_end(bytes: &[u8], quote: usize) -> Option<usize> {
        let mut cursor = quote + 1;
        while cursor < bytes.len() {
            match bytes[cursor] {
                b'\\' => cursor = cursor.saturating_add(2),
                b'"' => return Some(cursor + 1),
                b'\n' => return None,
                _ => cursor += 1,
            }
        }
        None
    }

    fn char_end(bytes: &[u8], quote: usize) -> Option<usize> {
        let mut cursor = quote + 1;
        if bytes.get(cursor) == Some(&b'\\') {
            cursor += 1;
            if bytes.get(cursor) == Some(&b'u') && bytes.get(cursor + 1) == Some(&b'{') {
                cursor += 2;
                let digits_start = cursor;
                while bytes.get(cursor).is_some_and(|byte| *byte != b'}') {
                    cursor += 1;
                }
                if cursor == digits_start || bytes.get(cursor) != Some(&b'}') {
                    return None;
                }
            } else if cursor >= bytes.len() {
                return None;
            }
            cursor += 1;
        } else {
            let character = std::str::from_utf8(bytes.get(cursor..)?)
                .ok()?
                .chars()
                .next()?;
            cursor += character.len_utf8();
        }
        (bytes.get(cursor) == Some(&b'\'')).then_some(cursor + 1)
    }

    /// Blanks comments and, when requested, literals without changing byte offsets.
    pub(crate) fn normalise(text: &str, literals: Literals) -> String {
        scan(text, literals, |_, _, _| {})
    }

    /// Full string-literal delimiter ranges and raw contents, from the same pass as `normalise`.
    pub(crate) fn string_literals(text: &str) -> Vec<(std::ops::Range<usize>, &str)> {
        let mut literals = Vec::new();
        scan(text, Literals::Keep, |start, content, end| {
            literals.push((start..end, &text[content]));
        });
        literals
    }

    fn scan(
        text: &str,
        literals: Literals,
        mut literal: impl FnMut(usize, std::ops::Range<usize>, usize),
    ) -> String {
        let mut bytes = text.as_bytes().to_vec();
        let mut cursor = 0;
        let mut block_depth = 0;
        while cursor < bytes.len() {
            if block_depth > 0 {
                if bytes.get(cursor..cursor + 2) == Some(b"/*") {
                    blank(&mut bytes, cursor, cursor + 2);
                    block_depth += 1;
                    cursor += 2;
                } else if bytes.get(cursor..cursor + 2) == Some(b"*/") {
                    blank(&mut bytes, cursor, cursor + 2);
                    block_depth -= 1;
                    cursor += 2;
                } else {
                    if bytes[cursor] != b'\n' {
                        bytes[cursor] = b' ';
                    }
                    cursor += 1;
                }
                continue;
            }

            if bytes.get(cursor..cursor + 2) == Some(b"//") {
                let start = cursor;
                while cursor < bytes.len() && bytes[cursor] != b'\n' {
                    cursor += 1;
                }
                blank(&mut bytes, start, cursor);
                continue;
            }
            if bytes.get(cursor..cursor + 2) == Some(b"/*") {
                blank(&mut bytes, cursor, cursor + 2);
                block_depth = 1;
                cursor += 2;
                continue;
            }

            let raw = raw_open(&bytes, cursor);
            if let Some((content_start, hashes)) = raw {
                if let Some(end) = raw_end(text.as_bytes(), content_start, hashes) {
                    literal(cursor, content_start..end - hashes - 1, end);
                    if literals == Literals::Blank {
                        blank(&mut bytes, cursor, end);
                    }
                    cursor = end;
                    continue;
                }
            }
            if bytes[cursor] == b'b' && bytes.get(cursor + 1) == Some(&b'"') {
                if let Some(end) = quoted_end(text.as_bytes(), cursor + 1) {
                    literal(cursor, cursor + 2..end - 1, end);
                    if literals == Literals::Blank {
                        blank(&mut bytes, cursor, end);
                    }
                    cursor = end;
                    continue;
                }
            }
            if bytes[cursor] == b'"' {
                if let Some(end) = quoted_end(text.as_bytes(), cursor) {
                    literal(cursor, cursor + 1..end - 1, end);
                    if literals == Literals::Blank {
                        blank(&mut bytes, cursor, end);
                    }
                    cursor = end;
                    continue;
                }
            }
            if bytes[cursor] == b'\'' {
                if let Some(end) = char_end(text.as_bytes(), cursor) {
                    if literals == Literals::Blank {
                        blank(&mut bytes, cursor, end);
                    }
                    cursor = end;
                    continue;
                }
            }
            cursor += 1;
        }
        String::from_utf8(bytes).expect("normalisation replaces only with ASCII bytes")
    }

    /// Finds the byte range of a braced source body, ignoring delimiters in comments and literals.
    pub(crate) fn braced_body(source: &str, signature: &str) -> std::ops::Range<usize> {
        let normalised = normalise(source, Literals::Blank);
        let signature_start = normalised
            .find(signature)
            .unwrap_or_else(|| panic!("signature {signature:?} must exist"));
        let opening = normalised[signature_start..]
            .find('{')
            .map(|offset| signature_start + offset)
            .unwrap_or_else(|| panic!("signature {signature:?} must have a body"));
        body_from_opening(&normalised, opening)
            .unwrap_or_else(|| panic!("signature {signature:?} has an unterminated body"))
    }

    /// Matches nested braces from an opening `{` in normalised source text.
    pub(crate) fn body_from_opening(
        normalised: &str,
        opening: usize,
    ) -> Option<std::ops::Range<usize>> {
        let mut depth = 0;
        for (offset, byte) in normalised.as_bytes()[opening..].iter().enumerate() {
            match byte {
                b'{' => depth += 1,
                b'}' => {
                    depth -= 1;
                    if depth == 0 {
                        return Some(opening..opening + offset + 1);
                    }
                }
                _ => {}
            }
        }
        None
    }

    /// The source text of `signature`'s body, from its signature line up to the first line at
    /// the same or an outer indentation that opens a new item or closes this one.
    pub(crate) fn body_at_indent<'a>(source: &'a str, signature: &str) -> &'a str {
        let sig_pos = source
            .find(signature)
            .unwrap_or_else(|| panic!("signature {signature:?} must exist"));
        let line_start = source[..sig_pos].rfind('\n').map(|i| i + 1).unwrap_or(0);
        let signature_line = source[line_start..]
            .split_once('\n')
            .map(|(line, _)| line)
            .unwrap_or(&source[line_start..]);
        let indent = signature_line.len() - signature_line.trim_start().len();
        let after_sig_line = match source[line_start..].find('\n') {
            Some(i) => line_start + i + 1,
            None => return &source[line_start..],
        };
        let rest = &source[after_sig_line..];
        let mut consumed = 0;
        for line in rest.split_inclusive('\n') {
            let content = line.strip_suffix('\n').unwrap_or(line);
            let content = content.strip_suffix('\r').unwrap_or(content);
            if is_same_or_outer_delimiter(content, indent) {
                return &source[line_start..after_sig_line + consumed];
            }
            consumed += line.len();
        }
        &source[line_start..]
    }

    fn is_same_or_outer_delimiter(line: &str, indent: usize) -> bool {
        if line.trim().is_empty() {
            return false;
        }
        let line_indent = line.len() - line.trim_start().len();
        if line_indent > indent {
            return false;
        }
        let trimmed = line.trim_start().trim_end_matches('\r');
        trimmed.starts_with("fn ")
            || trimmed.starts_with("pub fn ")
            || trimmed.starts_with("pub(crate) fn ")
            || trimmed.starts_with("pub(in ")
            || trimmed.starts_with("async fn ")
            || trimmed.starts_with("pub async fn ")
            || trimmed.starts_with("pub(crate) async fn ")
            || trimmed.starts_with("#[")
            || trimmed.starts_with("impl ")
            || trimmed.starts_with("mod ")
            || trimmed == "}"
    }

    #[cfg(test)]
    mod tests {
        use super::{body_from_opening, braced_body, normalise, string_literals, Literals};

        #[test]
        fn source_scan_matches_nested_braces_and_rejects_unterminated_body() {
            assert_eq!(body_from_opening("prefix { { } } suffix", 7), Some(7..14));
            assert_eq!(body_from_opening("prefix { { }", 7), None);
        }

        #[test]
        fn string_literals_plain() {
            assert_eq!(
                string_literals(r#"let x = "plain";"#),
                vec![(8..15, "plain")]
            );
        }

        #[test]
        fn string_literals_raw() {
            assert_eq!(
                string_literals(r##"r#"raw"# r"bare""##),
                vec![(0..8, "raw"), (9..16, "bare")]
            );
        }

        #[test]
        fn string_literals_byte_and_raw_byte() {
            assert_eq!(
                string_literals(r##"b"byte" br#"raw"#"##),
                vec![(0..7, "byte"), (8..17, "raw")]
            );
        }

        #[test]
        fn string_literals_escaped_quote() {
            assert_eq!(
                string_literals(r#""escaped\"quote""#),
                vec![(0..16, r#"escaped\"quote"#)]
            );
        }

        #[test]
        fn string_literals_skip_comment_quotes() {
            assert_eq!(
                string_literals("// \"line\"\n/* \"block\" */ \"kept\""),
                vec![(24..30, "kept")]
            );
        }

        #[test]
        fn string_literals_skip_quote_character() {
            assert_eq!(string_literals("'\"' \"kept\""), vec![(4..10, "kept")]);
        }

        #[test]
        fn string_literals_offsets_preserve_utf8_and_newlines() {
            let source = "/* ü */\n\"ä\" r#\"ö\"#";
            let contents = string_literals(source);
            assert_eq!(contents, vec![(9..13, "ä"), (14..21, "ö")]);
            for (range, _) in contents {
                assert!(source.is_char_boundary(range.start));
                assert!(source.is_char_boundary(range.end));
            }
        }

        fn assert_body(source: &str) {
            let range = braced_body(source, "fn body");
            let opening = source.find('{').expect("opening brace");
            assert_eq!(range.start, opening);
            assert_eq!(range.end, source.rfind('}').expect("closing brace") + 1);
            assert_eq!(&source[range.clone()], &source[opening..range.end]);
        }

        #[test]
        fn source_scan_ignores_line_comment_braces() {
            assert_body("fn body() { // }\n let _ = 1; }");
        }

        #[test]
        fn source_scan_ignores_nested_block_comment_braces() {
            assert_body("fn body() { /* { /* } */ } */ let _ = 1; }");
        }

        #[test]
        fn source_scan_ignores_escaped_plain_string_braces() {
            assert_body(r#"fn body() { let _ = "\"}"; }"#);
        }

        #[test]
        fn source_scan_ignores_raw_string_braces() {
            assert_body(r##"fn body() { let _ = r#"}"#; }"##);
        }

        #[test]
        fn source_scan_ignores_byte_string_braces() {
            assert_body(r##"fn body() { let _ = b"}"; }"##);
        }

        #[test]
        fn source_scan_ignores_char_literal_braces() {
            assert_body("fn body() { let _ = '}'; }");
        }

        #[test]
        fn source_scan_ignores_escaped_char_and_following_string_braces() {
            assert_body(r#"fn body() { let _ = '\''; let _ = "}"; }"#);
        }

        #[test]
        fn source_scan_ignores_two_hash_raw_byte_string_braces() {
            assert_body(r####"fn body() { let _ = br##"x"#}"##; }"####);
        }

        #[test]
        fn source_scan_keeps_lifetimes_and_ignores_brace_characters() {
            assert_body("fn body<'a>() { let _ = '{'; let _: &'a str = \"ok\"; }");
        }

        #[test]
        fn source_scan_ignores_multibyte_comment_and_literal_braces() {
            assert_body("fn body() { // ü }\n let _ = \"ä}\"; let _ = 'é'; }");
        }

        #[test]
        fn source_scan_normalise_preserves_offsets_newlines_and_utf8() {
            let source = "fn body() { // ü }\r\n let _ = \"ä}\"; /* é */\n }";
            for literals in [Literals::Blank, Literals::Keep] {
                let normalised = normalise(source, literals);
                assert_eq!(normalised.len(), source.len());
                assert_eq!(
                    normalised.match_indices('\n').collect::<Vec<_>>(),
                    source.match_indices('\n').collect::<Vec<_>>()
                );
                assert!(std::str::from_utf8(normalised.as_bytes()).is_ok());
            }
        }

        #[test]
        #[should_panic(expected = "signature")]
        fn source_scan_missing_signature_panics() {
            let _ = braced_body("fn other() {}", "fn body(");
        }
    }
}

fn panic_payload(payload: &(dyn Any + Send)) -> String {
    if let Some(message) = payload.downcast_ref::<&str>() {
        (*message).to_owned()
    } else if let Some(message) = payload.downcast_ref::<String>() {
        message.clone()
    } else {
        "unknown panic payload".to_owned()
    }
}

/// Test injectors are thread-local and `spawn_blocking` hops to another OS thread, so both
/// gateway methods have to carry the calling thread's injectors across and disarm the pooled
/// thread again afterwards. Captured once here rather than spelled out at each call site: the
/// two sequences have to stay identical, and a worker that keeps an injector after a panic
/// leaks it into whatever test runs on that pooled thread next.
#[cfg(test)]
struct CapturedInjectors {
    atomic: Option<Arc<dyn crate::infra::fs::AtomicWriterInjector + Send + Sync>>,
    #[cfg(unix)]
    removal: Option<Arc<dyn crate::infra::fs::RemovalInjector + Send + Sync>>,
}

#[cfg(test)]
impl CapturedInjectors {
    /// Called on the thread that owns the injectors, before the hop.
    fn capture() -> Self {
        Self {
            atomic: crate::infra::fs::current_test_atomic_file_injector(),
            #[cfg(unix)]
            removal: crate::infra::fs::current_test_removal_injector(),
        }
    }

    /// Called on the blocking worker. The returned guard disarms that thread on every exit path,
    /// including an unwind out of the closure.
    fn install(self) -> TestInjectorGuard {
        crate::infra::fs::set_test_atomic_file_injector(self.atomic);
        #[cfg(unix)]
        crate::infra::fs::set_test_removal_injector(self.removal);
        TestInjectorGuard
    }
}

#[cfg(test)]
struct TestInjectorGuard;

#[cfg(test)]
impl Drop for TestInjectorGuard {
    fn drop(&mut self) {
        crate::infra::fs::set_test_atomic_file_injector(None);
        #[cfg(unix)]
        crate::infra::fs::set_test_removal_injector(None);
    }
}

fn map_join<R>(
    join: Result<std::thread::Result<Result<R, Error>>, tokio::task::JoinError>,
) -> Result<R, Error> {
    match join {
        Ok(Ok(Ok(result))) => Ok(result),
        Ok(Ok(Err(error))) => Err(error),
        Ok(Err(payload)) => {
            log::error!("Blocking task panicked: {}", panic_payload(&*payload));
            Err(Error::Conflict("Blocking task panicked".into()))
        }
        Err(error) if error.is_cancelled() => Err(Error::Cancellation),
        Err(error) => {
            let message = match error.try_into_panic() {
                Ok(payload) => panic_payload(&*payload),
                Err(error) => error.to_string(),
            };
            log::error!("Blocking task panicked: {message}");
            Err(Error::Conflict("Blocking task panicked".into()))
        }
    }
}

async fn dispatch<F, R>(permit: OwnedSemaphorePermit, f: F) -> Result<R, Error>
where
    F: FnOnce() -> Result<R, Error> + Send + 'static,
    R: Send + 'static,
{
    #[cfg(test)]
    let injectors = CapturedInjectors::capture();

    let handle = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        #[cfg(test)]
        let _injector_guard = injectors.install();
        catch_unwind(AssertUnwindSafe(f))
    });

    map_join(handle.await)
}

impl BlockingGateway {
    pub fn new(max_concurrent: usize) -> Self {
        Self {
            semaphore: GatewaySemaphore::Explicit(Arc::new(Semaphore::new(max_concurrent))),
        }
    }

    #[cfg(test)]
    fn per_thread() -> Self {
        Self {
            semaphore: GatewaySemaphore::PerThread,
        }
    }

    fn semaphore(&self) -> Arc<Semaphore> {
        match &self.semaphore {
            GatewaySemaphore::Explicit(semaphore) => semaphore.clone(),
            #[cfg(test)]
            GatewaySemaphore::PerThread => THREAD_GATEWAY.with(Arc::clone),
        }
    }

    #[cfg(all(test, unix))]
    /// Capacity for isolated-gateway tests in other modules, which cannot reach the private semaphore.
    pub(crate) fn available_permits(&self) -> usize {
        self.semaphore().available_permits()
    }

    /// Runs admitted work to completion even if the awaiting future is dropped. The blocking
    /// worker owns the capacity permit until the closure actually exits.
    pub async fn spawn<F, R>(&self, f: F) -> Result<R, Error>
    where
        F: FnOnce() -> Result<R, Error> + Send + 'static,
        R: Send + 'static,
    {
        let permit = self
            .semaphore()
            .acquire_owned()
            .await
            .map_err(|_| Error::Cancellation)?;
        dispatch(permit, f).await
    }

    /// Derives an operation-local child token and cancels it when the awaiting future is dropped.
    /// Once admitted, the worker owns its permit and its true result wins any cancellation race;
    /// callers supply the cooperative checkpoints that decide when work can stop safely.
    pub async fn spawn_cancellable<F, R>(
        &self,
        cancellation: CancellationToken,
        f: F,
    ) -> Result<R, Error>
    where
        F: FnOnce(&CancellationToken) -> Result<R, Error> + Send + 'static,
        R: Send + 'static,
    {
        let worker_cancellation = cancellation.child_token();
        let awaiter_guard = worker_cancellation.clone().drop_guard();
        let permit = tokio::select! {
            biased;
            _ = worker_cancellation.cancelled() => return Err(Error::Cancellation),
            permit = self.semaphore().acquire_owned() => {
                permit.map_err(|_| Error::Cancellation)?
            }
        };
        let cancellation_at_worker = worker_cancellation.clone();
        let result = dispatch(permit, move || {
            if cancellation_at_worker.is_cancelled() {
                return Err(Error::Cancellation);
            }
            f(&cancellation_at_worker)
        })
        .await;
        awaiter_guard.disarm();
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::{Arc, Barrier, Condvar, Mutex};
    use std::time::Duration;
    use tokio::sync::mpsc;

    const TEST_DEADLINE: Duration = Duration::from_secs(5);

    #[derive(Clone)]
    struct WorkerHold(Arc<(Mutex<bool>, Condvar)>);

    impl WorkerHold {
        fn new() -> Self {
            Self(Arc::new((Mutex::new(true), Condvar::new())))
        }

        fn wait(&self) {
            let (lock, cvar) = &*self.0;
            let mut holding = lock.lock().unwrap();
            while *holding {
                holding = cvar.wait(holding).unwrap();
            }
        }

        fn release(&self) {
            let (lock, cvar) = &*self.0;
            *lock.lock().unwrap() = false;
            cvar.notify_all();
        }
    }

    struct ReleaseOnDrop(WorkerHold);

    impl Drop for ReleaseOnDrop {
        fn drop(&mut self) {
            self.0.release();
        }
    }

    struct ResetAtomicFileInjector;

    impl Drop for ResetAtomicFileInjector {
        fn drop(&mut self) {
            crate::infra::fs::set_test_atomic_file_injector(None);
        }
    }

    struct DropFlag(Arc<AtomicBool>);

    impl Drop for DropFlag {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }

    #[tokio::test]
    async fn panicking_closure_surfaces_conflict_and_does_not_abort() {
        let gateway = BlockingGateway::new(1);
        let result = gateway
            .spawn(|| -> Result<(), Error> { panic!("gateway test panic") })
            .await;
        assert!(
            matches!(result, Err(Error::Conflict(ref message)) if message == "Blocking task panicked")
        );
    }

    #[tokio::test]
    async fn err_from_closure_is_returned_unchanged() {
        let gateway = BlockingGateway::new(1);
        let result = gateway
            .spawn(|| -> Result<(), Error> { Err(Error::InvalidInput("from the closure".into())) })
            .await;
        assert!(
            matches!(result, Err(Error::InvalidInput(ref message)) if message == "from the closure")
        );
    }

    #[tokio::test]
    async fn panic_and_error_paths_release_capacity_for_both_methods() {
        let gateway = BlockingGateway::new(1);

        let spawn_panic = tokio::time::timeout(
            TEST_DEADLINE,
            gateway.spawn(|| -> Result<(), Error> { panic!("spawn panic") }),
        )
        .await
        .expect("spawn panic must return");
        assert!(matches!(spawn_panic, Err(Error::Conflict(_))));
        assert_eq!(gateway.semaphore().available_permits(), 1);

        let spawn_error = tokio::time::timeout(
            TEST_DEADLINE,
            gateway
                .spawn(|| -> Result<(), Error> { Err(Error::InvalidInput("spawn error".into())) }),
        )
        .await
        .expect("spawn error must return");
        assert!(matches!(spawn_error, Err(Error::InvalidInput(_))));
        assert_eq!(gateway.semaphore().available_permits(), 1);

        let cancellable_panic = tokio::time::timeout(
            TEST_DEADLINE,
            gateway.spawn_cancellable(CancellationToken::new(), |_| -> Result<(), Error> {
                panic!("cancellable panic")
            }),
        )
        .await
        .expect("cancellable panic must return");
        assert!(matches!(cancellable_panic, Err(Error::Conflict(_))));
        assert_eq!(gateway.semaphore().available_permits(), 1);

        let cancellable_error = tokio::time::timeout(
            TEST_DEADLINE,
            gateway.spawn_cancellable(CancellationToken::new(), |_| -> Result<(), Error> {
                Err(Error::InvalidInput("cancellable error".into()))
            }),
        )
        .await
        .expect("cancellable error must return");
        assert!(matches!(
            cancellable_error,
            Err(Error::InvalidInput(ref message)) if message == "cancellable error"
        ));
        assert_eq!(gateway.semaphore().available_permits(), 1);

        tokio::time::timeout(TEST_DEADLINE, gateway.spawn(|| Ok(())))
            .await
            .expect("all panic and error paths must release capacity")
            .unwrap();
        assert_eq!(gateway.semaphore().available_permits(), 1);
    }

    #[tokio::test]
    async fn spawn_cancellable_skips_closure_when_already_cancelled() {
        let gateway = BlockingGateway::new(1);
        let cancellation = CancellationToken::new();
        cancellation.cancel();
        let ran = Arc::new(AtomicBool::new(false));
        let ran_in_closure = ran.clone();
        let result = gateway
            .spawn_cancellable(cancellation, move |_| {
                ran_in_closure.store(true, Ordering::SeqCst);
                Ok(())
            })
            .await;
        assert!(matches!(result, Err(Error::Cancellation)));
        assert!(
            !ran.load(Ordering::SeqCst),
            "already-cancelled spawn_cancellable must not run the closure"
        );
    }

    #[tokio::test]
    async fn dropped_spawn_awaiter_keeps_capacity_until_worker_exit() {
        let gateway = Arc::new(BlockingGateway::new(1));
        let hold = WorkerHold::new();
        let _release = ReleaseOnDrop(hold.clone());
        let (entered_tx, mut entered_rx) = mpsc::unbounded_channel();
        let first_gateway = gateway.clone();
        let first_hold = hold.clone();
        let first = tokio::spawn(async move {
            first_gateway
                .spawn(move || {
                    entered_tx.send(()).unwrap();
                    first_hold.wait();
                    Ok(())
                })
                .await
        });
        tokio::time::timeout(TEST_DEADLINE, entered_rx.recv())
            .await
            .expect("first worker must enter")
            .expect("first worker entered");
        first.abort();
        let _ = first.await;
        assert_eq!(
            gateway.semaphore().available_permits(),
            0,
            "abandoning spawn must not release the worker's permit"
        );

        let second_ran = Arc::new(AtomicBool::new(false));
        let second_flag = second_ran.clone();
        let second_gateway = gateway.clone();
        let (attempted_tx, attempted_rx) = tokio::sync::oneshot::channel();
        let second = tokio::spawn(async move {
            attempted_tx.send(()).unwrap();
            second_gateway
                .spawn(move || {
                    second_flag.store(true, Ordering::SeqCst);
                    Ok(())
                })
                .await
        });
        tokio::time::timeout(TEST_DEADLINE, attempted_rx)
            .await
            .expect("second future must be polled")
            .expect("second admission attempted");
        assert!(
            !second_ran.load(Ordering::SeqCst),
            "abandoning spawn must not release capacity before its worker exits"
        );

        hold.release();
        tokio::time::timeout(TEST_DEADLINE, second)
            .await
            .expect("second worker must run after first exits")
            .unwrap()
            .unwrap();
        assert!(second_ran.load(Ordering::SeqCst));
        assert_eq!(gateway.semaphore().available_permits(), 1);
    }

    #[tokio::test]
    async fn queued_cancellation_returns_while_capacity_remains_held() {
        let gateway = Arc::new(BlockingGateway::new(1));
        let hold = WorkerHold::new();
        let _release = ReleaseOnDrop(hold.clone());
        let (entered_tx, mut entered_rx) = mpsc::unbounded_channel();
        let holder_gateway = gateway.clone();
        let holder_hold = hold.clone();
        let holder = tokio::spawn(async move {
            holder_gateway
                .spawn(move || {
                    entered_tx.send(()).unwrap();
                    holder_hold.wait();
                    Ok(())
                })
                .await
        });
        tokio::time::timeout(TEST_DEADLINE, entered_rx.recv())
            .await
            .expect("capacity holder must enter")
            .expect("capacity holder entered");

        let cancellation = CancellationToken::new();
        let cancellation_for_task = cancellation.clone();
        let queued_gateway = gateway.clone();
        let queued_ran = Arc::new(AtomicBool::new(false));
        let queued_flag = queued_ran.clone();
        let (attempted_tx, attempted_rx) = tokio::sync::oneshot::channel();
        let queued = tokio::spawn(async move {
            attempted_tx.send(()).unwrap();
            queued_gateway
                .spawn_cancellable(cancellation_for_task, move |_| {
                    queued_flag.store(true, Ordering::SeqCst);
                    Ok(())
                })
                .await
        });
        tokio::time::timeout(TEST_DEADLINE, attempted_rx)
            .await
            .expect("queued future must be polled")
            .expect("queued future started");
        cancellation.cancel();
        let result = tokio::time::timeout(TEST_DEADLINE, queued)
            .await
            .expect("queued cancellation must not wait for capacity")
            .unwrap();
        assert!(matches!(result, Err(Error::Cancellation)));
        assert!(!queued_ran.load(Ordering::SeqCst));

        hold.release();
        tokio::time::timeout(TEST_DEADLINE, holder)
            .await
            .expect("capacity holder must exit after release")
            .unwrap()
            .unwrap();
    }

    #[test]
    fn cancellation_after_dispatch_before_worker_entry_skips_closure() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .max_blocking_threads(1)
            .enable_time()
            .build()
            .expect("runtime");
        runtime.block_on(async {
            let pool_hold = WorkerHold::new();
            let _release = ReleaseOnDrop(pool_hold.clone());
            let (pool_entered_tx, mut pool_entered_rx) = mpsc::unbounded_channel();
            let blocker_hold = pool_hold.clone();
            let blocker = tokio::task::spawn_blocking(move || {
                pool_entered_tx.send(()).unwrap();
                blocker_hold.wait();
            });
            tokio::time::timeout(TEST_DEADLINE, pool_entered_rx.recv())
                .await
                .expect("pool blocker must enter")
                .expect("pool blocker entered");

            let gateway = Arc::new(BlockingGateway::new(1));
            let cancellation = CancellationToken::new();
            let cancellation_for_task = cancellation.clone();
            let ran = Arc::new(AtomicBool::new(false));
            let ran_in_worker = ran.clone();
            let worker_gateway = gateway.clone();
            let worker = tokio::spawn(async move {
                worker_gateway
                    .spawn_cancellable(cancellation_for_task, move |_| {
                        ran_in_worker.store(true, Ordering::SeqCst);
                        Ok(())
                    })
                    .await
            });
            tokio::time::timeout(TEST_DEADLINE, async {
                while gateway.semaphore().available_permits() != 0 {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .expect("worker dispatched and owns the permit");

            cancellation.cancel();
            pool_hold.release();
            tokio::time::timeout(TEST_DEADLINE, blocker)
                .await
                .expect("pool blocker must exit after release")
                .unwrap();
            let result = tokio::time::timeout(TEST_DEADLINE, worker)
                .await
                .expect("dispatched worker must return")
                .unwrap();
            assert!(matches!(result, Err(Error::Cancellation)));
            assert!(
                !ran.load(Ordering::SeqCst),
                "worker-entry cancellation check must skip the closure"
            );
        });
    }

    #[tokio::test]
    async fn dropped_cancellable_awaiter_cancels_worker_but_retains_capacity_until_exit() {
        let gateway = Arc::new(BlockingGateway::new(1));
        let parent = CancellationToken::new();
        let _cancel = parent.clone().drop_guard();
        let exit_hold = WorkerHold::new();
        let _release = ReleaseOnDrop(exit_hold.clone());
        let (entered_tx, mut entered_rx) = mpsc::unbounded_channel();
        let (cancelled_tx, mut cancelled_rx) = mpsc::unbounded_channel();
        let resource_dropped = Arc::new(AtomicBool::new(false));
        let worker_resource_dropped = resource_dropped.clone();
        let first_gateway = gateway.clone();
        let first_hold = exit_hold.clone();
        let worker_parent = parent.clone();
        let first = tokio::spawn(async move {
            first_gateway
                .spawn_cancellable(worker_parent, move |token| {
                    let _resource = DropFlag(worker_resource_dropped);
                    entered_tx.send(()).unwrap();
                    tokio::runtime::Handle::current().block_on(token.cancelled());
                    cancelled_tx.send(()).unwrap();
                    first_hold.wait();
                    Err::<(), _>(Error::Cancellation)
                })
                .await
        });
        tokio::time::timeout(TEST_DEADLINE, entered_rx.recv())
            .await
            .expect("cancellable worker must enter")
            .expect("cancellable worker entered");
        first.abort();
        let _ = first.await;
        tokio::time::timeout(TEST_DEADLINE, cancelled_rx.recv())
            .await
            .expect("worker must observe awaiter-drop cancellation")
            .expect("worker cancellation signal");
        assert_eq!(
            gateway.semaphore().available_permits(),
            0,
            "cancelled worker must retain its permit until cooperative exit"
        );

        let next_ran = Arc::new(AtomicBool::new(false));
        let next_flag = next_ran.clone();
        let next_gateway = gateway.clone();
        let (attempted_tx, attempted_rx) = tokio::sync::oneshot::channel();
        let next = tokio::spawn(async move {
            attempted_tx.send(()).unwrap();
            next_gateway
                .spawn(move || {
                    next_flag.store(true, Ordering::SeqCst);
                    Ok(())
                })
                .await
        });
        tokio::time::timeout(TEST_DEADLINE, attempted_rx)
            .await
            .expect("next future must be polled")
            .expect("next admission attempted");
        assert!(
            !next_ran.load(Ordering::SeqCst),
            "cancelled worker must retain capacity until cooperative exit"
        );

        exit_hold.release();
        tokio::time::timeout(TEST_DEADLINE, next)
            .await
            .expect("next worker must run after cancelled worker exits")
            .unwrap()
            .unwrap();
        assert!(next_ran.load(Ordering::SeqCst));
        assert_eq!(gateway.semaphore().available_permits(), 1);
        assert!(
            resource_dropped.load(Ordering::SeqCst),
            "cooperative worker exit must drop worker-owned resources"
        );
    }

    #[tokio::test]
    async fn awaiter_drop_cancels_only_its_child_token() {
        let gateway = Arc::new(BlockingGateway::new(2));
        let parent = CancellationToken::new();
        let hold = WorkerHold::new();
        let _release = ReleaseOnDrop(hold.clone());
        let (tokens_tx, mut tokens_rx) = mpsc::unbounded_channel();

        let start = |id, gateway: Arc<BlockingGateway>| {
            let parent = parent.clone();
            let hold = hold.clone();
            let tokens_tx = tokens_tx.clone();
            tokio::spawn(async move {
                gateway
                    .spawn_cancellable(parent, move |token| {
                        tokens_tx.send((id, token.clone())).unwrap();
                        hold.wait();
                        Ok(())
                    })
                    .await
            })
        };
        let first = start(1, gateway.clone());
        let second = start(2, gateway.clone());
        let mut first_child = None;
        let mut second_child = None;
        for _ in 0..2 {
            let (id, token) = tokio::time::timeout(TEST_DEADLINE, tokens_rx.recv())
                .await
                .expect("worker must announce its child token")
                .expect("child token");
            match id {
                1 => first_child = Some(token),
                2 => second_child = Some(token),
                _ => unreachable!(),
            }
        }
        let first_child = first_child.expect("first child token");
        let second_child = second_child.expect("second child token");

        first.abort();
        let _ = first.await;
        tokio::time::timeout(TEST_DEADLINE, first_child.cancelled())
            .await
            .expect("dropped awaiter's child must cancel");
        assert!(!parent.is_cancelled(), "child cancellation reached parent");
        assert!(
            !second_child.is_cancelled(),
            "child cancellation reached sibling"
        );

        hold.release();
        tokio::time::timeout(TEST_DEADLINE, second)
            .await
            .expect("sibling worker must return after release")
            .unwrap()
            .unwrap();
    }

    #[tokio::test]
    async fn cancellation_after_commit_does_not_replace_worker_result() {
        let gateway = Arc::new(BlockingGateway::new(1));
        let cancellation = CancellationToken::new();
        let hold = WorkerHold::new();
        let _release = ReleaseOnDrop(hold.clone());
        let (committed_tx, mut committed_rx) = mpsc::unbounded_channel();
        let worker_hold = hold.clone();
        let worker_cancellation = cancellation.clone();
        let worker = tokio::spawn(async move {
            gateway
                .spawn_cancellable(worker_cancellation, move |_| {
                    committed_tx.send(()).unwrap();
                    worker_hold.wait();
                    Ok(42)
                })
                .await
        });
        tokio::time::timeout(TEST_DEADLINE, committed_rx.recv())
            .await
            .expect("worker must announce commit")
            .expect("worker committed");
        cancellation.cancel();
        hold.release();
        let result = tokio::time::timeout(TEST_DEADLINE, worker)
            .await
            .expect("committed worker must return")
            .unwrap()
            .unwrap();
        assert_eq!(result, 42);
    }

    #[tokio::test]
    async fn spawn_never_runs_more_than_max_concurrent() {
        let gateway = Arc::new(BlockingGateway::new(2));
        let inflight = Arc::new(AtomicUsize::new(0));
        let high_water = Arc::new(AtomicUsize::new(0));
        let pair_entered = Arc::new(Barrier::new(3));
        let hold = Arc::new((Mutex::new(true), Condvar::new()));

        let start_holder = |gateway: Arc<BlockingGateway>| {
            let inflight = inflight.clone();
            let high_water = high_water.clone();
            let pair_entered = pair_entered.clone();
            let hold = hold.clone();
            tokio::spawn(async move {
                gateway
                    .spawn(move || {
                        let now = inflight.fetch_add(1, Ordering::SeqCst) + 1;
                        high_water.fetch_max(now, Ordering::SeqCst);
                        pair_entered.wait();
                        let (lock, cvar) = &*hold;
                        let mut holding = lock.lock().unwrap();
                        while *holding {
                            holding = cvar.wait(holding).unwrap();
                        }
                        inflight.fetch_sub(1, Ordering::SeqCst);
                        Ok(())
                    })
                    .await
            })
        };

        let first = start_holder(gateway.clone());
        let second = start_holder(gateway.clone());

        // Barrier wait is blocking; run it on the blocking pool or the current-thread
        // test runtime never polls the holders.
        let pair_entered_for_test = pair_entered.clone();
        tokio::task::spawn_blocking(move || {
            pair_entered_for_test.wait();
        })
        .await
        .unwrap();

        assert_eq!(high_water.load(Ordering::SeqCst), 2);
        assert_eq!(inflight.load(Ordering::SeqCst), 2);

        let third_ran = Arc::new(AtomicBool::new(false));
        let third_inflight = inflight.clone();
        let third_high_water = high_water.clone();
        let third_hold = hold.clone();
        let third_flag = third_ran.clone();
        let third_gateway = gateway.clone();
        let third = tokio::spawn(async move {
            third_gateway
                .spawn(move || {
                    let now = third_inflight.fetch_add(1, Ordering::SeqCst) + 1;
                    third_high_water.fetch_max(now, Ordering::SeqCst);
                    third_flag.store(true, Ordering::SeqCst);
                    let (lock, cvar) = &*third_hold;
                    let mut holding = lock.lock().unwrap();
                    while *holding {
                        holding = cvar.wait(holding).unwrap();
                    }
                    third_inflight.fetch_sub(1, Ordering::SeqCst);
                    Ok(())
                })
                .await
        });

        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(
            !third_ran.load(Ordering::SeqCst),
            "third closure ran while both permits were held"
        );
        assert!(high_water.load(Ordering::SeqCst) <= 2);

        {
            let (lock, cvar) = &*hold;
            *lock.lock().unwrap() = false;
            cvar.notify_all();
        }

        first.await.unwrap().unwrap();
        second.await.unwrap().unwrap();
        third.await.unwrap().unwrap();
        assert!(third_ran.load(Ordering::SeqCst));
        assert!(high_water.load(Ordering::SeqCst) <= 2);
    }

    struct FlagInjector(Arc<AtomicBool>);

    impl crate::infra::fs::AtomicWriterInjector for FlagInjector {
        fn inject(&self, _: crate::infra::fs::AtomicFileFaultPoint) -> std::io::Result<()> {
            self.0.store(true, Ordering::SeqCst);
            Ok(())
        }
    }

    #[tokio::test]
    async fn atomic_file_injector_fires_inside_spawn_blocking_worker() {
        let fired = Arc::new(AtomicBool::new(false));
        crate::infra::fs::set_test_atomic_file_injector(Some(Arc::new(FlagInjector(
            fired.clone(),
        ))));
        let _reset = ResetAtomicFileInjector;
        BLOCKING_GATEWAY
            .spawn(|| {
                crate::infra::fs::inject_atomic_file(crate::infra::fs::AtomicFileFaultPoint::Write)
            })
            .await
            .expect("spawn");
        assert!(
            fired.load(Ordering::SeqCst),
            "injector installed on the test thread must fire inside BLOCKING_GATEWAY.spawn"
        );
    }

    #[tokio::test]
    async fn atomic_file_injector_fires_inside_cancellable_worker() {
        let fired = Arc::new(AtomicBool::new(false));
        crate::infra::fs::set_test_atomic_file_injector(Some(Arc::new(FlagInjector(
            fired.clone(),
        ))));
        let _reset = ResetAtomicFileInjector;
        BLOCKING_GATEWAY
            .spawn_cancellable(CancellationToken::new(), |_| {
                crate::infra::fs::inject_atomic_file(crate::infra::fs::AtomicFileFaultPoint::Write)
            })
            .await
            .expect("spawn_cancellable");
        assert!(
            fired.load(Ordering::SeqCst),
            "injector installed on the test thread must fire inside spawn_cancellable"
        );
    }

    /// The injector and semaphore tests above all pass if `f` were simply called inline after
    /// `acquire`, which would put every converted command straight back on the runtime worker the
    /// offload exists to keep free. Only the thread identity distinguishes the two.
    #[tokio::test]
    async fn spawn_runs_the_closure_on_a_blocking_pool_thread() {
        let gateway = BlockingGateway::new(1);
        let caller = std::thread::current().id();
        let worker = gateway
            .spawn(move || Ok(std::thread::current().id()))
            .await
            .expect("spawn");
        assert_ne!(
            caller, worker,
            "spawn must hand the closure to spawn_blocking, not run it on the caller"
        );
    }

    #[tokio::test]
    async fn spawn_cancellable_runs_the_closure_on_a_blocking_pool_thread() {
        let gateway = BlockingGateway::new(1);
        let caller = std::thread::current().id();
        let worker = gateway
            .spawn_cancellable(CancellationToken::new(), move |_| {
                Ok(std::thread::current().id())
            })
            .await
            .expect("spawn_cancellable");
        assert_ne!(
            caller, worker,
            "spawn_cancellable must hand the closure to spawn_blocking, not run it on the caller"
        );
    }

    /// `TestInjectorGuard` is what stops a panicking worker from leaving a pooled thread armed
    /// with the previous test's injector. Deleting its `Drop` impl is invisible to every other
    /// test here, because `spawn` re-installs the captured injector on entry — so this drives a
    /// runtime with exactly one blocking thread and then asks that thread directly.
    #[test]
    fn a_panicking_worker_leaves_no_injector_on_the_pooled_thread() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .max_blocking_threads(1)
            .build()
            .expect("runtime");
        runtime.block_on(async {
            let gateway = BlockingGateway::new(1);
            crate::infra::fs::set_test_atomic_file_injector(Some(Arc::new(FlagInjector(
                Arc::new(AtomicBool::new(false)),
            ))));
            let _reset = ResetAtomicFileInjector;
            let result = gateway
                .spawn(|| -> Result<(), Error> { panic!("leaves the guard to clean up") })
                .await;
            assert!(matches!(result, Err(Error::Conflict(_))));
            crate::infra::fs::set_test_atomic_file_injector(None);

            let still_armed = tokio::task::spawn_blocking(|| {
                crate::infra::fs::current_test_atomic_file_injector().is_some()
            })
            .await
            .expect("plain spawn_blocking");
            assert!(
                !still_armed,
                "the guard must disarm the pooled thread even when the closure panicked"
            );
        });
    }

    /// Panic-free in Drop (CR-1): ignore lock/wait poison so a failing assertion cannot abort
    /// the test process on Windows.
    #[derive(Clone)]
    struct PermitHold(Arc<(Mutex<bool>, Condvar)>);

    impl PermitHold {
        fn new() -> Self {
            Self(Arc::new((Mutex::new(true), Condvar::new())))
        }

        fn wait(&self) {
            let (lock, cvar) = &*self.0;
            let Ok(mut holding) = lock.lock() else {
                return;
            };
            while *holding {
                match cvar.wait(holding) {
                    Ok(guard) => holding = guard,
                    Err(_) => return,
                }
            }
        }

        fn release(&self) {
            let (lock, cvar) = &*self.0;
            if let Ok(mut holding) = lock.lock() {
                *holding = false;
            }
            cvar.notify_all();
        }
    }

    struct ReleasePermitHold(PermitHold);

    impl Drop for ReleasePermitHold {
        fn drop(&mut self) {
            self.0.release();
        }
    }

    struct JoinThreadOnDrop(Option<std::thread::JoinHandle<()>>);

    impl Drop for JoinThreadOnDrop {
        fn drop(&mut self) {
            if let Some(handle) = self.0.take() {
                let _ = handle.join();
            }
        }
    }

    async fn park_global_gateway_holders(
        count: usize,
    ) -> (
        Vec<ReleasePermitHold>,
        Vec<tokio::task::JoinHandle<Result<(), Error>>>,
    ) {
        let mut releases = Vec::with_capacity(count);
        let mut workers = Vec::with_capacity(count);
        for _ in 0..count {
            let hold = PermitHold::new();
            releases.push(ReleasePermitHold(hold.clone()));
            let (entered_tx, mut entered_rx) = mpsc::unbounded_channel();
            workers.push(tokio::spawn(async move {
                BLOCKING_GATEWAY
                    .spawn(move || {
                        let _ = entered_tx.send(());
                        hold.wait();
                        Ok(())
                    })
                    .await
            }));
            tokio::time::timeout(TEST_DEADLINE, entered_rx.recv())
                .await
                .expect("global gateway holder must enter")
                .expect("global gateway holder entered");
        }
        (releases, workers)
    }

    #[tokio::test]
    async fn global_gateway_admits_on_another_thread_while_this_thread_holds_four() {
        let mut join_second = JoinThreadOnDrop(None);
        let (releases, workers) = park_global_gateway_holders(BLOCKING_GATEWAY_PERMITS).await;

        let (done_tx, done_rx) = tokio::sync::oneshot::channel();
        join_second.0 = Some(std::thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_time()
                .build()
                .expect("second-thread runtime");
            runtime.block_on(async {
                let mut admissions = Vec::with_capacity(BLOCKING_GATEWAY_PERMITS);
                for _ in 0..BLOCKING_GATEWAY_PERMITS {
                    admissions.push(tokio::spawn(async {
                        BLOCKING_GATEWAY.spawn(|| Ok(())).await
                    }));
                }
                for admission in admissions {
                    tokio::time::timeout(TEST_DEADLINE, admission)
                        .await
                        .expect(
                            "second-thread admission must complete while first thread holds four",
                        )
                        .expect("second-thread admission join")
                        .expect("second-thread spawn");
                }
            });
            let _ = done_tx.send(());
        }));

        tokio::time::timeout(TEST_DEADLINE, done_rx)
            .await
            .expect("second thread must finish four admissions while first thread holds four")
            .expect("second thread result");

        drop(releases);
        for worker in workers {
            tokio::time::timeout(TEST_DEADLINE, worker)
                .await
                .expect("holder must exit after release")
                .expect("holder join")
                .expect("holder spawn");
        }
    }

    #[tokio::test]
    async fn global_gateway_retains_four_permits_on_the_awaiting_thread() {
        let (mut releases, workers) = park_global_gateway_holders(BLOCKING_GATEWAY_PERMITS).await;

        let (fifth_tx, mut fifth_rx) = tokio::sync::oneshot::channel();
        let fifth = tokio::spawn(async move {
            BLOCKING_GATEWAY
                .spawn(move || {
                    let _ = fifth_tx.send(());
                    Ok(())
                })
                .await
        });

        assert!(
            tokio::time::timeout(Duration::from_millis(200), &mut fifth_rx)
                .await
                .is_err(),
            "fifth BLOCKING_GATEWAY admission must not be granted while four holders are parked"
        );

        drop(releases.remove(0));
        tokio::time::timeout(TEST_DEADLINE, fifth_rx)
            .await
            .expect("fifth must be granted after one holder is released")
            .expect("fifth entered");
        tokio::time::timeout(TEST_DEADLINE, fifth)
            .await
            .expect("fifth spawn must finish")
            .expect("fifth join")
            .expect("fifth result");

        drop(releases);
        for worker in workers {
            tokio::time::timeout(TEST_DEADLINE, worker)
                .await
                .expect("holder must exit after release")
                .expect("holder join")
                .expect("holder spawn");
        }
    }
}
