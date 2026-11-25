//! Handing a game link from a second launch to the running instance.
//!
//! The instance lock stays the authority on who owns the application data directory
//! (`d-20261007-31`). On top of it, the owner listens on a loopback port and publishes that port
//! together with a random token in the directory (`HandoffDirectory`). A later launch that was
//! refused by the lock and carries a game link delivers it there and exits; in every other case
//! it shows the "already running" dialog as before.
//!
//! The port is reachable by every local user and by any web page in a browser, which is why a
//! request must begin with the token and why the link is parsed again by the owner.

use std::io::{BufRead as _, BufReader, Read as _, Write as _};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use rand::RngCore as _;
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::sync::{oneshot, Semaphore};
use tokio::task::JoinSet;

use crate::error::Error;
use crate::infra::game_link::{launch_link, Intake};
use crate::infra::path_authority::{
    AppDataDir, HandoffDirectory, HandoffEndpoint, PublishedEndpoint,
};

const TOKEN_BYTES: usize = 32;

/// Token line plus link line. A request that needs more is refused.
const MAX_REQUEST_BYTES: usize = 1024;

/// Requests served at once; a further connection is closed unanswered.
const MAX_CONNECTIONS: usize = 4;

/// How long one connection may take from accept to answer.
const CONNECTION_DEADLINE: Duration = Duration::from_secs(2);

/// How long a second launch keeps trying before it shows the dialog.
const DELIVERY_DEADLINE: Duration = Duration::from_secs(3);

/// The pause before a delivery reads the endpoint again (the owner may still be starting), and
/// before the owner accepts again after a failed accept.
const RETRY_PAUSE: Duration = Duration::from_millis(250);

/// The limit on each connect of a delivery. A listening owner on loopback accepts at once. A
/// closed port answers at once on Unix, but Windows retries for about two seconds before it
/// reports the refusal, which would spend the whole delivery deadline on one attempt.
const DELIVERY_CONNECT_TIMEOUT: Duration = Duration::from_millis(250);

/// The limit on each send and receive of a delivery.
const DELIVERY_IO_TIMEOUT: Duration = Duration::from_secs(2);

/// How much the owner reads and discards after its answer before it closes regardless.
const MAX_DRAINED_BYTES: usize = 64 * 1024;

/// How long shutdown waits for the listener task before it removes the endpoint regardless.
const SHUTDOWN_WAIT: Duration = Duration::from_secs(2);

/// The intake every accepted request ends in (`accept_game_link` in `main.rs`).
pub(crate) type LinkIntake = Arc<dyn Fn(&str) -> Intake + Send + Sync>;

/// The owner's one-line answer. `Accepted` is sent only after the link has been enqueued.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Answer {
    Accepted,
    Refused,
    Full,
}

impl Answer {
    fn wire(self) -> &'static str {
        match self {
            Self::Accepted => "accepted\n",
            Self::Refused => "refused\n",
            Self::Full => "full\n",
        }
    }

    fn from_wire(line: &str) -> Option<Self> {
        [Self::Accepted, Self::Refused, Self::Full]
            .into_iter()
            .find(|answer| answer.wire() == line)
    }
}

impl From<Intake> for Answer {
    fn from(intake: Intake) -> Self {
        match intake {
            Intake::Queued => Self::Accepted,
            Intake::Refused => Self::Refused,
            Intake::Full => Self::Full,
        }
    }
}

fn new_token() -> String {
    let mut bytes = [0_u8; TOKEN_BYTES];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Compares without stopping at the first difference.
fn same_bytes(left: &[u8], right: &[u8]) -> bool {
    left.len() == right.len()
        && left
            .iter()
            .zip(right)
            .fold(0_u8, |difference, (a, b)| difference | (a ^ b))
            == 0
}

struct Published {
    directory: HandoffDirectory,
    endpoint: PublishedEndpoint,
}

/// The listener of the instance that owns the application data directory. One per process,
/// owned by the application state; stopped by [`HandoffOwner::shutdown`] on application exit.
/// Dropping it without a shutdown (a crash path) also stops the listener task, and the endpoint
/// file it leaves behind is removed by the next owner before that owner binds.
pub(crate) struct HandoffOwner {
    published: Arc<Published>,
    stop: Mutex<Option<oneshot::Sender<()>>>,
    server: tokio::sync::Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
}

impl HandoffOwner {
    /// Removes a stale endpoint, binds, and publishes port and token. On any failure nothing
    /// stays behind: the listener is dropped and no endpoint file exists.
    pub(crate) fn start(directory: HandoffDirectory, intake: LinkIntake) -> Result<Self, Error> {
        Self::start_with_deadline(directory, intake, CONNECTION_DEADLINE)
    }

    fn start_with_deadline(
        directory: HandoffDirectory,
        intake: LinkIntake,
        connection_deadline: Duration,
    ) -> Result<Self, Error> {
        directory.remove_stale()?;
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
        listener.set_nonblocking(true)?;
        let token = new_token();
        let endpoint = directory.publish(&HandoffEndpoint {
            port: listener.local_addr()?.port(),
            token: token.clone(),
        })?;
        let (stop, stopped) = oneshot::channel();
        let server = tauri::async_runtime::spawn(serve(
            listener,
            token,
            intake,
            connection_deadline,
            stopped,
        ));
        Ok(Self {
            published: Arc::new(Published {
                directory,
                endpoint,
            }),
            stop: Mutex::new(Some(stop)),
            server: tokio::sync::Mutex::new(Some(server)),
        })
    }

    /// Stops the listener and removes the endpoint file if it is still this process's file.
    /// Idempotent; a removal failure is logged and never fails the exit.
    pub(crate) async fn shutdown(&self) {
        let stop = self
            .stop
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        let Some(stop) = stop else { return };
        let _ = stop.send(());
        let server = self.server.lock().await.take();
        if let Some(server) = server {
            match tokio::time::timeout(SHUTDOWN_WAIT, server).await {
                Ok(Ok(())) => {}
                Ok(Err(error)) => log::warn!("the game-link handoff listener failed: {error}"),
                Err(_) => log::warn!("the game-link handoff listener did not stop in time"),
            }
        }
        let published = self.published.clone();
        let removal = tauri::async_runtime::spawn_blocking(move || {
            published.directory.remove(&published.endpoint)
        })
        .await;
        match removal {
            Ok(Ok(())) => {}
            Ok(Err(error)) if error.is_missing_entry() => {}
            Ok(Err(error)) => log::warn!(
                "the game-link handoff endpoint could not be removed: {}",
                error.diagnostic()
            ),
            Err(error) => log::warn!("the game-link handoff endpoint removal failed: {error}"),
        }
    }
}

/// The listener task. It ends when `stopped` fires or its sender is dropped, and takes every
/// connection task with it.
async fn serve(
    listener: TcpListener,
    token: String,
    intake: LinkIntake,
    connection_deadline: Duration,
    mut stopped: oneshot::Receiver<()>,
) {
    let listener = match tokio::net::TcpListener::from_std(listener) {
        Ok(listener) => listener,
        Err(error) => {
            log::warn!("the game-link handoff listener could not start: {error}");
            return;
        }
    };
    let token: Arc<str> = token.into();
    let slots = Arc::new(Semaphore::new(MAX_CONNECTIONS));
    let mut connections = JoinSet::new();
    loop {
        tokio::select! {
            _ = &mut stopped => break,
            Some(_) = connections.join_next(), if !connections.is_empty() => {}
            accepted = listener.accept() => {
                let stream = match accepted {
                    Ok((stream, _)) => stream,
                    Err(error) => {
                        log::warn!("the game-link handoff listener could not accept: {error}");
                        tokio::time::sleep(RETRY_PAUSE).await;
                        continue;
                    }
                };
                // Over the bound the connection is dropped here, which closes it.
                let Ok(slot) = slots.clone().try_acquire_owned() else { continue };
                let token = token.clone();
                let intake = intake.clone();
                connections.spawn(async move {
                    let _slot = slot;
                    let _ = tokio::time::timeout(
                        connection_deadline,
                        answer_request(stream, &token, intake.as_ref()),
                    )
                    .await;
                });
            }
        }
    }
    connections.shutdown().await;
}

/// One request: `<token>\n<link>\n`. A first line that is not the token is refused without
/// reading the rest; the link is enqueued before the answer is written.
async fn answer_request(
    mut stream: tokio::net::TcpStream,
    token: &str,
    intake: &(dyn Fn(&str) -> Intake + Send + Sync),
) -> std::io::Result<()> {
    let link_start = token.len() + 1;
    let mut request = Vec::with_capacity(256);
    let mut chunk = [0_u8; 256];
    let mut token_matched = false;
    let answer = loop {
        if !token_matched {
            match request.iter().position(|byte| *byte == b'\n') {
                Some(end) if same_bytes(&request[..end], token.as_bytes()) => token_matched = true,
                Some(_) => break Answer::Refused,
                None if request.len() > token.len() => break Answer::Refused,
                None => {}
            }
        }
        if token_matched {
            if let Some(length) = request[link_start..].iter().position(|byte| *byte == b'\n') {
                break match std::str::from_utf8(&request[link_start..link_start + length]) {
                    Ok(link) => intake(link).into(),
                    Err(_) => Answer::Refused,
                };
            }
        }
        if request.len() >= MAX_REQUEST_BYTES {
            break Answer::Refused;
        }
        let room = (MAX_REQUEST_BYTES - request.len()).min(chunk.len());
        let read = stream.read(&mut chunk[..room]).await?;
        if read == 0 {
            return Ok(());
        }
        request.extend_from_slice(&chunk[..read]);
    };
    stream.write_all(answer.wire().as_bytes()).await?;
    stream.shutdown().await?;
    // Read the peer out before closing. Closing a socket that still holds unread bytes resets
    // the connection, and a reset that overtakes the answer makes Windows discard it unread.
    // The caller's connection deadline and the byte bound end this for a peer that keeps sending.
    let mut drained = 0;
    while drained < MAX_DRAINED_BYTES {
        match stream.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(read) => drained += read,
        }
    }
    Ok(())
}

/// What a second launch achieved with its link.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Delivery {
    /// The running instance enqueued the link.
    Accepted,
    /// Not delivered; the text is the log's failure category and never contains link or token.
    Failed(&'static str),
}

#[derive(Clone, Copy)]
struct DeliveryTiming {
    deadline: Duration,
    retry_pause: Duration,
    connect_timeout: Duration,
    io_timeout: Duration,
}

impl DeliveryTiming {
    const PRODUCTION: Self = Self {
        deadline: DELIVERY_DEADLINE,
        retry_pause: RETRY_PAUSE,
        connect_timeout: DELIVERY_CONNECT_TIMEOUT,
        io_timeout: DELIVERY_IO_TIMEOUT,
    };
}

/// The second launch's whole decision: `true` only when this process was started with a game
/// link and the running instance accepted it. The caller then exits quietly; on `false` it shows
/// the "already running" dialog. Blocking, by design: it runs in the refused launch's setup,
/// before any window or runtime work exists.
pub(crate) fn hand_launch_link_to_owner(app_data: &AppDataDir) -> bool {
    let Some(link) = launch_link(std::env::args_os()) else {
        return false;
    };
    let delivery = match app_data.handoff_directory() {
        Ok(directory) => deliver(|| directory.read(), &link, DeliveryTiming::PRODUCTION),
        Err(_) => Delivery::Failed("the application data directory could not be opened"),
    };
    match delivery {
        Delivery::Accepted => true,
        Delivery::Failed(category) => {
            log::warn!("the game link was not handed to the running instance: {category}");
            false
        }
    }
}

/// Reads the endpoint anew for every attempt and retries only while nothing has been sent: a
/// missing or unreadable endpoint and a refused connection are retried until the deadline, an
/// exchange that has begun is final whatever its outcome.
fn deliver(
    mut read_endpoint: impl FnMut() -> Result<Option<HandoffEndpoint>, Error>,
    link: &str,
    timing: DeliveryTiming,
) -> Delivery {
    let deadline = Instant::now() + timing.deadline;
    loop {
        let failure = match read_endpoint() {
            Ok(Some(endpoint)) => {
                let address = SocketAddr::from((Ipv4Addr::LOCALHOST, endpoint.port));
                let remaining = deadline.saturating_duration_since(Instant::now());
                match TcpStream::connect_timeout(&address, connect_limit(remaining, timing)) {
                    Ok(stream) => {
                        return exchange(stream, &endpoint.token, link, timing.io_timeout)
                    }
                    Err(_) => "the running instance did not accept a connection",
                }
            }
            Ok(None) => "the running instance has published no handoff endpoint",
            Err(_) => "the handoff endpoint could not be read",
        };
        if deadline.saturating_duration_since(Instant::now()) <= timing.retry_pause {
            return Delivery::Failed(failure);
        }
        std::thread::sleep(timing.retry_pause);
    }
}

/// One connect never outlasts the delivery deadline, and never the connect timeout. Never zero,
/// which `connect_timeout` rejects.
fn connect_limit(remaining: Duration, timing: DeliveryTiming) -> Duration {
    remaining
        .min(timing.connect_timeout)
        .max(Duration::from_millis(1))
}

/// From the first written byte the outcome is final: the owner may already have enqueued the
/// link, so sending it again could open the game twice.
fn exchange(mut stream: TcpStream, token: &str, link: &str, io_timeout: Duration) -> Delivery {
    let sent = stream
        .set_write_timeout(Some(io_timeout))
        .and_then(|()| stream.set_read_timeout(Some(io_timeout)))
        .and_then(|()| stream.write_all(format!("{token}\n{link}\n").as_bytes()));
    if sent.is_err() {
        return Delivery::Failed("the link could not be sent to the running instance");
    }
    let mut answer = String::new();
    let longest = Answer::Accepted.wire().len() as u64;
    if BufReader::new(stream.take(longest))
        .read_line(&mut answer)
        .is_err()
    {
        return Delivery::Failed("the running instance did not answer");
    }
    match Answer::from_wire(&answer) {
        Some(Answer::Accepted) => Delivery::Accepted,
        Some(Answer::Refused) => Delivery::Failed("the running instance refused the link"),
        Some(Answer::Full) => Delivery::Failed("the running instance has too many links waiting"),
        None => Delivery::Failed("the running instance did not answer"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    const LINK: &str = "chessriddle-studio://import?url=https%3A%2F%2Flichess.org%2Fabcdefgh";

    const FAST: DeliveryTiming = DeliveryTiming {
        deadline: Duration::from_millis(600),
        retry_pause: Duration::from_millis(20),
        connect_timeout: Duration::from_millis(100),
        io_timeout: Duration::from_millis(300),
    };

    struct Fixture {
        _root: tempfile::TempDir,
        directory: HandoffDirectory,
        owner: HandoffOwner,
        received: Arc<Mutex<Vec<String>>>,
    }

    fn handoff_directory(root: &std::path::Path) -> HandoffDirectory {
        AppDataDir::for_test(root).handoff_directory().unwrap()
    }

    /// An owner whose intake records every link it is offered and answers `intake`.
    fn owner(intake: Intake, connection_deadline: Duration) -> Fixture {
        let root = tempfile::tempdir().unwrap();
        let received = Arc::new(Mutex::new(Vec::new()));
        let recorder = received.clone();
        let owner = HandoffOwner::start_with_deadline(
            handoff_directory(root.path()),
            Arc::new(move |link: &str| {
                recorder.lock().unwrap().push(link.to_owned());
                intake
            }),
            connection_deadline,
        )
        .unwrap();
        Fixture {
            directory: handoff_directory(root.path()),
            _root: root,
            owner,
            received,
        }
    }

    impl Fixture {
        fn endpoint(&self) -> HandoffEndpoint {
            self.directory
                .read()
                .unwrap()
                .expect("a published endpoint")
        }

        fn connect(&self) -> TcpStream {
            let stream = TcpStream::connect((Ipv4Addr::LOCALHOST, self.endpoint().port)).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            stream
        }

        fn received(&self) -> Vec<String> {
            self.received.lock().unwrap().clone()
        }
    }

    /// Polls until `condition` holds; a loaded machine only makes this slower, never wrong.
    fn eventually(mut condition: impl FnMut() -> bool) -> bool {
        let until = Instant::now() + Duration::from_secs(10);
        loop {
            if condition() {
                return true;
            }
            if Instant::now() >= until {
                return false;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    /// Everything the owner sends until it closes the connection.
    fn read_to_close(mut stream: TcpStream) -> String {
        let mut answer = String::new();
        let _ = stream.read_to_string(&mut answer);
        answer
    }

    fn request(fixture: &Fixture, bytes: &[u8]) -> String {
        let mut stream = fixture.connect();
        stream.write_all(bytes).unwrap();
        read_to_close(stream)
    }

    /// The owner's answer line, without waiting for the owner to close.
    fn read_answer(stream: &TcpStream) -> String {
        let mut line = String::new();
        BufReader::new(stream.try_clone().unwrap())
            .read_line(&mut line)
            .unwrap();
        line
    }

    #[test]
    fn a_connect_is_limited_by_its_own_timeout_and_by_the_remaining_deadline() {
        assert!(FAST.connect_timeout < FAST.io_timeout);
        assert_eq!(connect_limit(FAST.deadline, FAST), FAST.connect_timeout);
        assert_eq!(
            connect_limit(Duration::from_millis(40), FAST),
            Duration::from_millis(40)
        );
        assert_eq!(
            connect_limit(Duration::ZERO, FAST),
            Duration::from_millis(1)
        );
        // Several attempts fit the deadline even where a closed port answers only by timeout.
        assert!(DELIVERY_CONNECT_TIMEOUT + RETRY_PAUSE <= DELIVERY_DEADLINE / 4);
    }

    #[test]
    fn the_owner_reads_the_peer_out_after_its_answer() {
        // A close with unread bytes resets the connection, and a reset can destroy the answer
        // before the peer has read it. So the connection stays readable after the answer.
        let fixture = owner(Intake::Queued, Duration::from_secs(30));
        let mut stream = fixture.connect();
        stream
            .set_write_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        stream
            .write_all(&vec![b'x'; MAX_REQUEST_BYTES + 10])
            .unwrap();
        assert_eq!(read_answer(&stream), "refused\n");

        for _ in 0..8 {
            std::thread::sleep(Duration::from_millis(25));
            stream
                .write_all(&[b'x'; 1024])
                .expect("the owner still reads what the peer sends");
        }
        assert!(fixture.received().is_empty());
    }

    #[test]
    fn the_owner_stops_reading_a_peer_that_keeps_sending() {
        // The connection deadline is far away: only the byte bound can end this.
        let fixture = owner(Intake::Queued, Duration::from_secs(60));
        let mut stream = fixture.connect();
        stream
            .set_write_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        stream.write_all(b"not the token\n").unwrap();
        assert_eq!(read_answer(&stream), "refused\n");

        let chunk = [b'x'; 4096];
        let closed =
            (0..64 * MAX_DRAINED_BYTES / chunk.len()).any(|_| stream.write_all(&chunk).is_err());
        assert!(closed, "the owner read megabytes from a refused peer");
    }

    #[test]
    fn tokens_are_long_random_and_compared_in_full() {
        let token = new_token();
        assert_eq!(token.len(), TOKEN_BYTES * 2);
        assert!(token.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert_ne!(token, new_token());
        assert!(same_bytes(b"abc", b"abc"));
        assert!(!same_bytes(b"abc", b"abd"));
        assert!(!same_bytes(b"abc", b"xbc"));
        assert!(!same_bytes(b"abc", b"abcd"));
        assert!(!same_bytes(b"", b"a"));
        assert!(same_bytes(b"", b""));
    }

    #[test]
    fn a_delivered_link_is_enqueued_once_and_accepted() {
        let fixture = owner(Intake::Queued, CONNECTION_DEADLINE);
        let endpoint = fixture.endpoint();
        assert_eq!(endpoint.token.len(), TOKEN_BYTES * 2);

        let delivery = deliver(|| fixture.directory.read(), LINK, FAST);

        assert_eq!(delivery, Delivery::Accepted);
        assert_eq!(fixture.received(), [LINK]);
    }

    #[test]
    fn the_owner_answers_what_the_intake_decided() {
        for (intake, answer, delivery) in [
            (Intake::Queued, "accepted\n", Delivery::Accepted),
            (
                Intake::Refused,
                "refused\n",
                Delivery::Failed("the running instance refused the link"),
            ),
            (
                Intake::Full,
                "full\n",
                Delivery::Failed("the running instance has too many links waiting"),
            ),
        ] {
            let fixture = owner(intake, CONNECTION_DEADLINE);
            let token = fixture.endpoint().token;
            assert_eq!(
                request(&fixture, format!("{token}\n{LINK}\n").as_bytes()),
                answer
            );
            assert_eq!(deliver(|| fixture.directory.read(), LINK, FAST), delivery);
            // Each request reached the intake exactly once: nothing was retried.
            assert_eq!(fixture.received(), [LINK, LINK]);
        }
    }

    #[test]
    fn a_wrong_token_is_refused_without_reaching_the_intake() {
        let fixture = owner(Intake::Queued, CONNECTION_DEADLINE);
        let token = fixture.endpoint().token;
        let mut almost = token.clone().into_bytes();
        *almost.last_mut().unwrap() ^= 1;
        let almost = String::from_utf8(almost).unwrap();

        for first_line in [
            "POST / HTTP/1.1",
            "",
            almost.as_str(),
            &token[..token.len() - 1],
            &format!("{token}x"),
        ] {
            assert_eq!(
                request(&fixture, format!("{first_line}\n{LINK}\n").as_bytes()),
                "refused\n",
                "{first_line}"
            );
        }
        // No newline at all: refused as soon as the line is longer than a token can be.
        assert_eq!(request(&fixture, &[b'a'; 200]), "refused\n");
        assert!(fixture.received().is_empty());
        assert_eq!(
            deliver(
                || Ok(Some(HandoffEndpoint {
                    port: fixture.endpoint().port,
                    token: "0".repeat(TOKEN_BYTES * 2),
                })),
                LINK,
                FAST
            ),
            Delivery::Failed("the running instance refused the link")
        );
        assert!(fixture.received().is_empty());
    }

    #[test]
    fn an_oversized_or_non_text_link_is_refused() {
        let fixture = owner(Intake::Queued, CONNECTION_DEADLINE);
        let token = fixture.endpoint().token;

        let mut oversized = format!("{token}\n").into_bytes();
        oversized.resize(MAX_REQUEST_BYTES + 10, b'a');
        assert_eq!(request(&fixture, &oversized), "refused\n");

        let mut non_text = format!("{token}\n").into_bytes();
        non_text.extend_from_slice(&[0xff, 0xfe, b'\n']);
        assert_eq!(request(&fixture, &non_text), "refused\n");

        // The largest request that still fits is passed on unchanged.
        let longest = "x".repeat(MAX_REQUEST_BYTES - token.len() - 2);
        assert_eq!(
            request(&fixture, format!("{token}\n{longest}\n").as_bytes()),
            "accepted\n"
        );
        assert_eq!(fixture.received(), [longest]);
    }

    #[test]
    fn a_silent_or_incomplete_request_is_closed_at_the_deadline_unanswered() {
        let fixture = owner(Intake::Queued, Duration::from_millis(150));
        let token = fixture.endpoint().token;
        let started = Instant::now();

        let mut partial = fixture.connect();
        partial
            .write_all(format!("{token}\nchess").as_bytes())
            .unwrap();
        assert_eq!(read_to_close(partial), "");
        assert_eq!(read_to_close(fixture.connect()), "");

        assert!(started.elapsed() >= Duration::from_millis(150));
        assert!(fixture.received().is_empty());
        // A client that hangs up early is not answered either, and the owner keeps serving.
        let mut gone = fixture.connect();
        gone.write_all(token.as_bytes()).unwrap();
        drop(gone);
        assert_eq!(
            deliver(|| fixture.directory.read(), LINK, FAST),
            Delivery::Accepted
        );
    }

    #[test]
    fn at_most_four_connections_are_served_at_once() {
        let fixture = owner(Intake::Queued, Duration::from_secs(3));
        // Connections are accepted in the order they were made, so these four hold every slot
        // by the time the fifth is accepted.
        let held: Vec<TcpStream> = (0..MAX_CONNECTIONS).map(|_| fixture.connect()).collect();
        let token = fixture.endpoint().token;

        // The fifth is closed unanswered although its request is complete and correct.
        assert_eq!(
            request(&fixture, format!("{token}\n{LINK}\n").as_bytes()),
            ""
        );
        assert!(fixture.received().is_empty());

        // Once the held connections are gone their slots return.
        drop(held);
        assert!(eventually(|| {
            deliver(|| fixture.directory.read(), LINK, FAST) == Delivery::Accepted
        }));
        assert_eq!(fixture.received(), [LINK]);
    }

    #[test]
    fn the_endpoint_is_read_again_for_every_attempt() {
        let fixture = owner(Intake::Queued, CONNECTION_DEADLINE);
        let endpoint = fixture.endpoint();
        let reads = AtomicUsize::new(0);

        let delivery = deliver(
            || match reads.fetch_add(1, Ordering::SeqCst) {
                0 => Ok(None),
                1 => Err(Error::InvalidInput("half written".into())),
                _ => Ok(Some(endpoint.clone())),
            },
            LINK,
            FAST,
        );

        assert_eq!(delivery, Delivery::Accepted);
        assert_eq!(reads.load(Ordering::SeqCst), 3);
        assert_eq!(fixture.received(), [LINK]);
    }

    #[test]
    fn a_missing_endpoint_or_a_closed_port_is_retried_until_the_deadline() {
        let reads = AtomicUsize::new(0);
        let started = Instant::now();
        let missing = deliver(
            || {
                reads.fetch_add(1, Ordering::SeqCst);
                Ok(None)
            },
            LINK,
            FAST,
        );
        assert_eq!(
            missing,
            Delivery::Failed("the running instance has published no handoff endpoint")
        );
        assert!(reads.load(Ordering::SeqCst) > 3);
        assert!(started.elapsed() >= FAST.deadline - FAST.retry_pause * 2);

        // A port nobody listens on. Not one bound and released: the system may hand a released
        // port at once to another test's listener, and port 1 lies below every ephemeral range.
        let closed_port = 1;
        let attempts = AtomicUsize::new(0);
        let refused = deliver(
            || {
                attempts.fetch_add(1, Ordering::SeqCst);
                Ok(Some(HandoffEndpoint {
                    port: closed_port,
                    token: "0".repeat(TOKEN_BYTES * 2),
                }))
            },
            LINK,
            FAST,
        );
        assert_eq!(
            refused,
            Delivery::Failed("the running instance did not accept a connection")
        );
        assert!(attempts.load(Ordering::SeqCst) > 1);

        assert_eq!(
            deliver(|| Err(Error::InvalidInput("unreadable".into())), LINK, FAST),
            Delivery::Failed("the handoff endpoint could not be read")
        );
    }

    #[test]
    fn nothing_is_sent_twice_once_bytes_have_left() {
        // A listener that takes the request and hangs up without answering.
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let connections = Arc::new(AtomicUsize::new(0));
        let seen = connections.clone();
        let server = std::thread::spawn(move || {
            listener.set_nonblocking(true).unwrap();
            let until = Instant::now() + Duration::from_millis(900);
            while Instant::now() < until {
                if let Ok((mut stream, _)) = listener.accept() {
                    seen.fetch_add(1, Ordering::SeqCst);
                    stream.set_nonblocking(false).unwrap();
                    let mut request = [0_u8; 512];
                    let _ = stream.read(&mut request);
                } else {
                    std::thread::sleep(Duration::from_millis(5));
                }
            }
        });
        let reads = AtomicUsize::new(0);

        let delivery = deliver(
            || {
                reads.fetch_add(1, Ordering::SeqCst);
                Ok(Some(HandoffEndpoint {
                    port,
                    token: "0".repeat(TOKEN_BYTES * 2),
                }))
            },
            LINK,
            FAST,
        );
        server.join().unwrap();

        assert_eq!(
            delivery,
            Delivery::Failed("the running instance did not answer")
        );
        assert_eq!(reads.load(Ordering::SeqCst), 1);
        assert_eq!(connections.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn starting_replaces_a_stale_endpoint_and_shutdown_retires_its_own() {
        let root = tempfile::tempdir().unwrap();
        let stale = HandoffEndpoint {
            port: 1,
            token: "stale".into(),
        };
        handoff_directory(root.path()).publish(&stale).unwrap();
        let directory = handoff_directory(root.path());

        let intakes = Arc::new(AtomicUsize::new(0));
        let owner = HandoffOwner::start(handoff_directory(root.path()), {
            let intakes = intakes.clone();
            Arc::new(move |_: &str| {
                intakes.fetch_add(1, Ordering::SeqCst);
                Intake::Queued
            })
        })
        .unwrap();
        let endpoint = directory.read().unwrap().unwrap();
        assert_ne!(endpoint, stale);
        assert_eq!(deliver(|| directory.read(), LINK, FAST), Delivery::Accepted);
        assert_eq!(intakes.load(Ordering::SeqCst), 1);

        tauri::async_runtime::block_on(owner.shutdown());

        assert_eq!(directory.read().unwrap(), None);
        // Its listener is closed: a link sent to the old endpoint no longer reaches its intake.
        // The port itself proves nothing, because the system may hand it to another listener.
        assert_ne!(
            deliver(|| Ok(Some(endpoint.clone())), LINK, FAST),
            Delivery::Accepted
        );
        assert_eq!(intakes.load(Ordering::SeqCst), 1);
        // A second shutdown has nothing left to do.
        tauri::async_runtime::block_on(owner.shutdown());
    }

    #[test]
    fn shutdown_leaves_an_endpoint_a_later_owner_published() {
        let root = tempfile::tempdir().unwrap();
        let first = HandoffOwner::start(
            handoff_directory(root.path()),
            Arc::new(|_: &str| Intake::Queued),
        )
        .unwrap();
        let second = HandoffOwner::start(
            handoff_directory(root.path()),
            Arc::new(|_: &str| Intake::Queued),
        )
        .unwrap();
        let directory = handoff_directory(root.path());
        let published = directory.read().unwrap().unwrap();

        tauri::async_runtime::block_on(first.shutdown());

        assert_eq!(directory.read().unwrap(), Some(published));
        assert_eq!(deliver(|| directory.read(), LINK, FAST), Delivery::Accepted);
        tauri::async_runtime::block_on(second.shutdown());
        assert_eq!(directory.read().unwrap(), None);
    }

    #[cfg(unix)]
    #[test]
    fn a_failed_start_leaves_neither_a_listener_nor_an_endpoint() {
        let root = tempfile::tempdir().unwrap();
        // A directory in the endpoint's place: the stale removal refuses it.
        std::fs::create_dir(root.path().join("link-handoff.json")).unwrap();

        let started = HandoffOwner::start(
            handoff_directory(root.path()),
            Arc::new(|_: &str| Intake::Queued),
        );

        assert!(started.is_err());
        assert!(handoff_directory(root.path()).read().is_err());
        assert!(root.path().join("link-handoff.json").is_dir());
    }

    #[test]
    fn dropping_the_owner_stops_the_listener() {
        let fixture = owner(Intake::Queued, CONNECTION_DEADLINE);
        let port = fixture.endpoint().port;
        let Fixture {
            owner,
            directory,
            received,
            ..
        } = fixture;

        drop(owner);

        // A stopped listener no longer hands links to its intake. Whether the port still refuses
        // proves nothing, because the system may hand it to another listener at once.
        assert!(eventually(
            || deliver(|| directory.read(), LINK, FAST) != Delivery::Accepted
        ));
        let offered = received.lock().unwrap().len();
        // The file stays for the next owner to remove; a delivery to it fails and is reported.
        assert_eq!(
            directory.read().unwrap().map(|endpoint| endpoint.port),
            Some(port)
        );
        assert!(matches!(
            deliver(|| directory.read(), LINK, FAST),
            Delivery::Failed(_)
        ));
        assert_eq!(received.lock().unwrap().len(), offered);
    }
}
