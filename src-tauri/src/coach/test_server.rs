//! Doubles for Coach tests: a loopback HTTP server that plays the provider, and a keyring that
//! can be made to fail.

use std::sync::atomic::{AtomicBool, Ordering};

use axum::Router;
use tokio::sync::oneshot;

use crate::{
    credentials::{CredentialStore, MemoryCredentialStore},
    error::Error,
};

/// A keyring whose reads can be made to fail, as when the secret service does not answer, and
/// whose next write can be made to fail once.
#[derive(Default)]
pub(crate) struct FaultyStore {
    inner: MemoryCredentialStore,
    pub silent: AtomicBool,
    pub fail_next_write: AtomicBool,
}

impl CredentialStore for FaultyStore {
    fn set(&self, key: &str, secret: &str) -> Result<(), Error> {
        if self.fail_next_write.swap(false, Ordering::SeqCst) {
            return Err(Error::CredentialRecoveryRequired);
        }
        self.inner.set(key, secret)
    }
    fn get(&self, key: &str) -> Result<Option<String>, Error> {
        if self.silent.load(Ordering::SeqCst) {
            return Err(Error::CredentialRecoveryRequired);
        }
        self.inner.get(key)
    }
    fn delete(&self, key: &str) -> Result<(), Error> {
        self.inner.delete(key)
    }
}

pub(crate) struct TestServer {
    origin: String,
    shutdown: Option<oneshot::Sender<()>>,
}

impl TestServer {
    /// `http://127.0.0.1:<port>` followed by `path`.
    pub(crate) fn url(&self, path: &str) -> String {
        format!("{}{path}", self.origin)
    }
}

impl Drop for TestServer {
    fn drop(&mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
    }
}

/// Serves `router` on an OS-chosen loopback port until the returned handle is dropped.
pub(crate) fn serve(router: Router) -> TestServer {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("loopback port");
    listener
        .set_nonblocking(true)
        .expect("non-blocking listener");
    let origin = format!("http://{}", listener.local_addr().expect("local address"));
    let (shutdown, stopped) = oneshot::channel::<()>();
    let server = axum::Server::from_tcp(listener)
        .expect("test server")
        .serve(router.into_make_service())
        .with_graceful_shutdown(async move {
            let _ = stopped.await;
        });
    tokio::spawn(async move {
        let _ = server.await;
    });
    TestServer {
        origin,
        shutdown: Some(shutdown),
    }
}
