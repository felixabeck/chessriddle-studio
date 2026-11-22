//! A loopback HTTP server for Coach tests: the provider double.

use axum::Router;
use tokio::sync::oneshot;

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
