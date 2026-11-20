use crate::error::Error;

pub struct SoundServerPort(pub u16);
pub struct SoundShutdownTx(pub std::sync::Mutex<Option<tokio::sync::oneshot::Sender<()>>>);

mod server {
    use crate::error::Error;
    use crate::infra::path_authority::AuthorizedDir;
    use axum::{
        body::StreamBody,
        extract::Path as AxumPath,
        http::{header, HeaderMap, StatusCode},
        response::IntoResponse,
        routing::get,
        Extension, Router,
    };
    use std::io::{Read, Seek};
    use std::net::TcpListener;
    use std::{path::Path, sync::Arc};

    fn sound_stream(
        file: crate::infra::inode_ownership::OwnedFile,
        remaining: u64,
    ) -> impl futures_util::Stream<Item = std::io::Result<Vec<u8>>> {
        futures_util::stream::try_unfold((file, remaining), |(mut file, remaining)| async move {
            if remaining == 0 {
                return Ok(None);
            }
            tokio::task::spawn_blocking(move || {
                let mut bytes = vec![0; remaining.min(65536) as usize];
                let count = file.read(&mut bytes)?;
                if count == 0 {
                    return Ok(None);
                }
                bytes.truncate(count);
                Ok(Some((bytes, (file, remaining - count as u64))))
            })
            .await
            .map_err(std::io::Error::other)?
        })
    }

    #[derive(Debug, PartialEq)]
    pub enum RangeParseResult {
        Valid(usize, usize),
        InvalidSyntax,
        NotSatisfiable,
    }

    pub fn parse_range(range_header: &str, total_len: usize) -> RangeParseResult {
        let range_str = match range_header.strip_prefix("bytes=") {
            Some(s) => s,
            None => return RangeParseResult::InvalidSyntax,
        };
        if range_str.contains(',') {
            return RangeParseResult::InvalidSyntax;
        }
        let mut parts = range_str.splitn(2, '-');
        let start_str = match parts.next() {
            Some(s) => s.trim(),
            None => return RangeParseResult::InvalidSyntax,
        };
        let end_str = match parts.next() {
            Some(s) => s.trim(),
            None => return RangeParseResult::InvalidSyntax,
        };

        if start_str.is_empty() {
            match end_str.parse::<usize>() {
                Ok(suffix) if suffix > 0 => {
                    if total_len == 0 {
                        RangeParseResult::NotSatisfiable
                    } else {
                        let start = total_len.saturating_sub(suffix);
                        let end = total_len - 1;
                        RangeParseResult::Valid(start, end)
                    }
                }
                _ => RangeParseResult::InvalidSyntax,
            }
        } else {
            match start_str.parse::<usize>() {
                Ok(start) => {
                    if start >= total_len {
                        return RangeParseResult::NotSatisfiable;
                    }
                    let end = if end_str.is_empty() {
                        total_len - 1
                    } else {
                        match end_str.parse::<usize>() {
                            Ok(e) => e.min(total_len - 1),
                            Err(_) => return RangeParseResult::InvalidSyntax,
                        }
                    };
                    if start <= end {
                        RangeParseResult::Valid(start, end)
                    } else {
                        RangeParseResult::InvalidSyntax
                    }
                }
                Err(_) => RangeParseResult::InvalidSyntax,
            }
        }
    }

    fn content_type_for(path: &std::path::Path) -> &'static str {
        match path.extension().and_then(|e| e.to_str()) {
            Some("mp3") => "audio/mpeg",
            Some("ogg") => "audio/ogg",
            Some("wav") => "audio/wav",
            Some("flac") => "audio/flac",
            _ => "application/octet-stream",
        }
    }

    pub(crate) async fn serve_sound(
        AxumPath(path): AxumPath<String>,
        headers: HeaderMap,
        Extension(sound_dir): Extension<Arc<AuthorizedDir>>,
    ) -> impl IntoResponse {
        let requested_path = Path::new(&path);
        let directory = sound_dir.clone();
        let relative = requested_path.to_path_buf();
        let opened =
            tokio::task::spawn_blocking(move || directory.open_regular_relative(&relative)).await;
        let mut file = match opened {
            Ok(Ok(file)) => file,
            Ok(Err(Error::InvalidInput(_))) => return StatusCode::NOT_FOUND.into_response(),
            Ok(Err(error)) if error.is_missing_entry() => {
                return StatusCode::NOT_FOUND.into_response();
            }
            Ok(Err(error)) => {
                log::warn!("sound request {:?} could not be opened: {}", path, error);
                return StatusCode::NOT_FOUND.into_response();
            }
            Err(error) => {
                log::warn!("sound request {:?} filesystem task failed: {}", path, error);
                return StatusCode::INTERNAL_SERVER_ERROR.into_response();
            }
        };

        let (opened, metadata) = match tokio::task::spawn_blocking(move || {
            let metadata = file.metadata();
            (file, metadata)
        })
        .await
        {
            Ok(result) => result,
            Err(error) => {
                log::warn!("sound request {:?} metadata task failed: {}", path, error);
                return StatusCode::INTERNAL_SERVER_ERROR.into_response();
            }
        };
        file = opened;
        let metadata = match metadata {
            Ok(m) => m,
            Err(error) => {
                log::warn!("sound request {:?} metadata failed: {}", path, error);
                return StatusCode::INTERNAL_SERVER_ERROR.into_response();
            }
        };
        if !metadata.is_file() {
            return StatusCode::NOT_FOUND.into_response();
        }

        let total_len = metadata.len() as usize;
        let content_type = content_type_for(requested_path);

        if let Some(range_val) = headers.get(header::RANGE) {
            if let Ok(range_str) = range_val.to_str() {
                match parse_range(range_str, total_len) {
                    RangeParseResult::Valid(start, end) => {
                        let length = end - start + 1;
                        let seek = tokio::task::spawn_blocking(move || {
                            let result = file.seek(std::io::SeekFrom::Start(start as u64));
                            (file, result)
                        })
                        .await;
                        let (opened, result) = match seek {
                            Ok(result) => result,
                            Err(error) => {
                                log::warn!("sound request {:?} seek task failed: {}", path, error);
                                return StatusCode::INTERNAL_SERVER_ERROR.into_response();
                            }
                        };
                        file = opened;
                        if let Err(error) = result {
                            log::warn!("sound request {:?} seek failed: {}", path, error);
                            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
                        }

                        let stream = sound_stream(file, length as u64);
                        let body = StreamBody::new(stream);

                        return (
                            StatusCode::PARTIAL_CONTENT,
                            [
                                (header::CONTENT_TYPE, content_type.to_string()),
                                (header::ACCEPT_RANGES, "bytes".to_string()),
                                (header::CONTENT_LENGTH, length.to_string()),
                                (
                                    header::CONTENT_RANGE,
                                    format!("bytes {start}-{end}/{total_len}"),
                                ),
                            ],
                            body,
                        )
                            .into_response();
                    }
                    RangeParseResult::NotSatisfiable => {
                        return (
                            StatusCode::RANGE_NOT_SATISFIABLE,
                            [(header::CONTENT_RANGE, format!("bytes */{total_len}"))],
                            (),
                        )
                            .into_response();
                    }
                    RangeParseResult::InvalidSyntax => {}
                }
            }
        }

        let stream = sound_stream(file, u64::MAX);
        let body = StreamBody::new(stream);

        (
            StatusCode::OK,
            [
                (header::CONTENT_TYPE, content_type.to_string()),
                (header::ACCEPT_RANGES, "bytes".to_string()),
                (header::CONTENT_LENGTH, total_len.to_string()),
            ],
            body,
        )
            .into_response()
    }

    pub fn create_sound_server_with_seam<L, B, S, Fut>(
        bind_fn: B,
        server_fn: S,
        sound_dir: AuthorizedDir,
        shutdown_rx: tokio::sync::oneshot::Receiver<()>,
    ) -> Result<(u16, impl std::future::Future<Output = ()>), std::io::Error>
    where
        B: FnOnce() -> std::io::Result<(u16, L)>,
        S: FnOnce(L, Router, tokio::sync::oneshot::Receiver<()>) -> std::io::Result<Fut>,
        Fut: std::future::Future<Output = ()> + Send + 'static,
    {
        let (port, listener) = bind_fn()?;

        let app = Router::new()
            .route("/*path", get(serve_sound))
            .layer(Extension(Arc::new(sound_dir)));

        let server_future = server_fn(listener, app, shutdown_rx)?;

        log::info!("Sound server prepared on port {port}");
        Ok((port, server_future))
    }

    pub fn create_sound_server(
        sound_dir: AuthorizedDir,
        shutdown_rx: tokio::sync::oneshot::Receiver<()>,
    ) -> Result<(u16, impl std::future::Future<Output = ()>), std::io::Error> {
        create_sound_server_with_seam(
            || {
                let listener = TcpListener::bind("127.0.0.1:0")?;
                let port = listener.local_addr()?.port();
                Ok((port, listener))
            },
            |listener, app, rx| {
                let server =
                    crate::infra::runtime::with_reactor(|| axum::Server::from_tcp(listener))
                        .map_err(|e| std::io::Error::other(e.to_string()))?;
                Ok(async move {
                    if let Err(e) = server
                        .serve(app.into_make_service())
                        .with_graceful_shutdown(async {
                            let _ = rx.await;
                        })
                        .await
                    {
                        log::error!("Sound server error: {}", e);
                    }
                })
            },
            sound_dir,
            shutdown_rx,
        )
    }
}

pub use server::create_sound_server;

#[tauri::command]
#[specta::specta]
pub fn get_sound_server_port(state: tauri::State<'_, SoundServerPort>) -> Result<u16, Error> {
    Ok(state.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Bundled sound now reaches the renderer only as a loopback URL, so the native-path command
    /// must not come back. This pin lives under `sound::tests` so `cargo test sound::` selects it.
    #[test]
    fn sound_resource_path_is_gone_from_main() {
        for (name, source) in [
            ("main.rs", include_str!("main.rs")),
            (
                "workspace_commands.rs",
                include_str!("workspace_commands.rs"),
            ),
        ] {
            assert!(
                !source.contains("sound_resource_path"),
                "sound_resource_path must not be registered or imported in {name}"
            );
        }
    }

    /// A restored per-test platform gate would only redden CI on macOS and Windows. Construct the
    /// needle at runtime so this pin's own source does not contain the substring it forbids.
    #[test]
    fn sound_module_has_no_linux_platform_gate() {
        let source = include_str!("sound.rs");
        let needle = ["target_os = ", "\"linux\""].concat();
        assert!(!source.contains(&needle), "{needle} must not gate sound.rs");
    }

    /// The `protocol-asset` feature is the last compile-time trace of the deleted asset grant.
    /// Construct the needle at runtime for the same reason as the platform-gate pin.
    #[test]
    fn cargo_tauri_features_have_no_protocol_asset() {
        let manifest = include_str!("../Cargo.toml");
        let needle = ["protocol", "-asset"].concat();
        let tauri_feature_lines: Vec<_> = manifest
            .lines()
            .filter(|line| line.trim_start().starts_with("tauri ="))
            .collect();
        assert!(!tauri_feature_lines.is_empty(), "tauri dependency line");
        for line in tauri_feature_lines {
            assert!(!line.contains(&needle), "{line}");
        }
    }

    fn authorized_sound_dir() -> (
        tempfile::TempDir,
        crate::infra::path_authority::AuthorizedDir,
    ) {
        use crate::infra::path_authority::{open_app_owned_resource_dir, ResourceDir};

        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("sound")).unwrap();
        let directory = open_app_owned_resource_dir(&ResourceDir::for_test(root.path())).unwrap();
        (root, directory)
    }

    #[test]
    fn test_sound_range_matrix() {
        use server::RangeParseResult::*;
        assert_eq!(server::parse_range("bytes=0-499", 1000), Valid(0, 499));
        assert_eq!(server::parse_range("bytes=500-999", 1000), Valid(500, 999));
        assert_eq!(server::parse_range("bytes=-500", 1000), Valid(500, 999));
        assert_eq!(server::parse_range("bytes=9500-", 10000), Valid(9500, 9999));
        assert_eq!(server::parse_range("bytes=0-0", 1000), Valid(0, 0));
        assert_eq!(server::parse_range("bytes=-0", 1000), InvalidSyntax);
        assert_eq!(server::parse_range("bytes=1000-", 1000), NotSatisfiable);
        assert_eq!(
            server::parse_range("bytes=0-499,500-999", 1000),
            InvalidSyntax
        );
        assert_eq!(server::parse_range("0-499", 1000), InvalidSyntax);
        assert_eq!(server::parse_range("bytes=500-2000", 1000), Valid(500, 999));
        assert_eq!(server::parse_range("bytes=1000-2000", 1000), NotSatisfiable);
        assert_eq!(server::parse_range("bytes=0-", 0), NotSatisfiable);
        assert_eq!(server::parse_range("bytes=500-200", 1000), InvalidSyntax);
    }

    #[tokio::test]
    async fn test_sound_server_ephemeral_startup() {
        let (_root, sound_dir) = authorized_sound_dir();
        let (tx, rx) = tokio::sync::oneshot::channel();
        let (port, server_future) = server::create_sound_server_with_seam(
            || Ok((42, ())),
            |(), _, rx| {
                Ok(async move {
                    let _ = rx.await;
                })
            },
            sound_dir,
            rx,
        )
        .unwrap();
        assert_eq!(port, 42);
        tx.send(()).unwrap();
        // Server future should exit cleanly when shutdown signal is received
        server_future.await;
    }

    #[tokio::test]
    async fn test_sound_server_bind_failure() {
        let (_root, sound_dir) = authorized_sound_dir();
        let (_tx, rx) = tokio::sync::oneshot::channel();
        let result = server::create_sound_server_with_seam(
            || {
                Err(std::io::Error::new(
                    std::io::ErrorKind::AddrInUse,
                    "bind failed",
                ))
            },
            |_: (), _, _| -> Result<std::future::Ready<()>, std::io::Error> { unreachable!() },
            sound_dir,
            rx,
        );
        let err = match result {
            Err(e) => e,
            Ok(_) => panic!("expected error"),
        };
        assert_eq!(err.kind(), std::io::ErrorKind::AddrInUse);
    }

    #[tokio::test]
    async fn test_sound_server_construction_failure() {
        let (_root, sound_dir) = authorized_sound_dir();
        let (_tx, rx) = tokio::sync::oneshot::channel();
        let result = server::create_sound_server_with_seam(
            || Ok((42, ())),
            |(), _, _| -> Result<std::future::Ready<()>, std::io::Error> {
                Err(std::io::Error::other("from_tcp failed"))
            },
            sound_dir,
            rx,
        );
        let err = match result {
            Err(e) => e,
            Ok(_) => panic!("expected error"),
        };
        assert_eq!(err.kind(), std::io::ErrorKind::Other);
    }

    /// The seam tests above drive `create_sound_server_with_seam` with fakes, so nothing covered
    /// the real `from_tcp` wiring and a startup panic shipped unnoticed.
    ///
    /// This must stay a plain `#[test]`: `setup()` calls `create_sound_server` from the main
    /// thread with no ambient runtime, and `#[tokio::test]` would supply the reactor that
    /// production does not have — reintroducing the panic would leave the test green.
    #[test]
    fn test_real_sound_server_binds_without_an_ambient_runtime() {
        let (_root, sound_dir) = authorized_sound_dir();
        let (_tx, rx) = tokio::sync::oneshot::channel();
        let (port, _server_future) = server::create_sound_server(sound_dir, rx)
            .expect("sound server must be constructible outside a Tokio runtime");
        assert_ne!(port, 0);
    }

    // Renaming the resource directory while `AuthorizedDir` holds it open is a sharing violation
    // on Windows, not a symlink; containment there is the other `open_regular_relative` tests.
    #[cfg(unix)]
    #[tokio::test]
    async fn sound_server_keeps_serving_from_the_authorized_descriptor_after_a_root_swap() {
        let (root, sound_dir) = authorized_sound_dir();
        tokio::fs::write(root.path().join("sound/test.mp3"), b"authorized bytes")
            .await
            .unwrap();
        let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel();
        let (port, server) = server::create_sound_server(sound_dir, shutdown_rx).unwrap();

        tokio::fs::rename(
            root.path().join("sound"),
            root.path().join("sound-original"),
        )
        .await
        .unwrap();
        tokio::fs::create_dir(root.path().join("sound"))
            .await
            .unwrap();
        tokio::fs::write(root.path().join("sound/test.mp3"), b"impostor bytes")
            .await
            .unwrap();

        let join = tokio::spawn(server);
        let response = reqwest::get(format!("http://127.0.0.1:{port}/test.mp3"))
            .await
            .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::OK);
        assert_eq!(
            response.bytes().await.unwrap().as_ref(),
            b"authorized bytes"
        );
        shutdown_tx.send(()).unwrap();
        join.await.unwrap();
    }

    #[tokio::test]
    async fn test_serve_sound_handler() {
        use axum::body::HttpBody;
        use axum::extract::Path as AxumPath;
        use axum::http::{header, HeaderMap, StatusCode};
        use axum::response::IntoResponse;
        use axum::Extension;
        use std::sync::Arc;

        async fn read_body(mut body: axum::body::BoxBody) -> Vec<u8> {
            let mut bytes = Vec::new();
            while let Some(chunk) = body.data().await {
                bytes.extend_from_slice(&chunk.unwrap());
            }
            bytes
        }

        let (dir, sound_dir) = authorized_sound_dir();
        let sound_path = dir.path().join("sound");
        let file_path = sound_path.join("test.mp3");
        tokio::fs::write(&file_path, b"1234567890").await.unwrap();

        let empty_path = sound_path.join("empty.mp3");
        tokio::fs::write(&empty_path, b"").await.unwrap();
        tokio::fs::create_dir(sound_path.join("a")).await.unwrap();
        tokio::fs::write(sound_path.join("a/b.mp3"), b"nested")
            .await
            .unwrap();
        tokio::fs::write(dir.path().join("outside.mp3"), b"outside bytes")
            .await
            .unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(
            dir.path().join("outside.mp3"),
            sound_path.join("linked.mp3"),
        )
        .unwrap();
        let outside_dir = dir.path().join("outside_dir");
        tokio::fs::create_dir(&outside_dir).await.unwrap();
        tokio::fs::write(outside_dir.join("x.mp3"), b"escaped nested")
            .await
            .unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside_dir, sound_path.join("link")).unwrap();
        let sound_dir = Arc::new(sound_dir);

        // Valid full response
        let headers = HeaderMap::new();
        let res = server::serve_sound(
            AxumPath("test.mp3".to_string()),
            headers,
            Extension(sound_dir.clone()),
        )
        .await
        .into_response();
        assert_eq!(res.status(), StatusCode::OK);
        let body_bytes = read_body(res.into_body()).await;
        assert_eq!(body_bytes, b"1234567890");

        // Full and ranged bodies must survive more than one streaming read.
        let large: Vec<u8> = (0..200_000).map(|index| (index % 251) as u8).collect();
        tokio::fs::write(sound_path.join("large.mp3"), &large)
            .await
            .unwrap();
        let res = server::serve_sound(
            AxumPath("large.mp3".to_string()),
            HeaderMap::new(),
            Extension(sound_dir.clone()),
        )
        .await
        .into_response();
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(res.headers().get(header::CONTENT_LENGTH).unwrap(), "200000");
        assert_eq!(read_body(res.into_body()).await, large);
        let mut headers = HeaderMap::new();
        headers.insert(header::RANGE, "bytes=60000-140000".parse().unwrap());
        let res = server::serve_sound(
            AxumPath("large.mp3".to_string()),
            headers,
            Extension(sound_dir.clone()),
        )
        .await
        .into_response();
        assert_eq!(res.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(res.headers().get(header::CONTENT_LENGTH).unwrap(), "80001");
        assert_eq!(
            res.headers().get(header::CONTENT_RANGE).unwrap(),
            "bytes 60000-140000/200000"
        );
        assert_eq!(read_body(res.into_body()).await, large[60000..=140000]);

        // Valid partial range
        let mut headers = HeaderMap::new();
        headers.insert(header::RANGE, "bytes=2-4".parse().unwrap());
        let res = server::serve_sound(
            AxumPath("test.mp3".to_string()),
            headers,
            Extension(sound_dir.clone()),
        )
        .await
        .into_response();
        assert_eq!(res.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(
            res.headers().get(header::CONTENT_TYPE).unwrap(),
            "audio/mpeg"
        );
        assert_eq!(res.headers().get(header::ACCEPT_RANGES).unwrap(), "bytes");
        assert_eq!(res.headers().get(header::CONTENT_LENGTH).unwrap(), "3");
        assert_eq!(
            res.headers().get(header::CONTENT_RANGE).unwrap(),
            "bytes 2-4/10"
        );
        let body_bytes = read_body(res.into_body()).await;
        assert_eq!(body_bytes, b"345");

        // Invalid range semantics (ignored, falls back to full content)
        let mut headers = HeaderMap::new();
        headers.insert(header::RANGE, "invalid".parse().unwrap());
        let res = server::serve_sound(
            AxumPath("test.mp3".to_string()),
            headers,
            Extension(sound_dir.clone()),
        )
        .await
        .into_response();
        assert_eq!(res.status(), StatusCode::OK);
        let body_bytes = read_body(res.into_body()).await;
        assert_eq!(body_bytes, b"1234567890");

        // Unsatisfiable range semantics (returns 416)
        let mut headers = HeaderMap::new();
        headers.insert(header::RANGE, "bytes=100-200".parse().unwrap());
        let res = server::serve_sound(
            AxumPath("test.mp3".to_string()),
            headers,
            Extension(sound_dir.clone()),
        )
        .await
        .into_response();
        assert_eq!(res.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        assert_eq!(
            res.headers().get(header::CONTENT_RANGE).unwrap(),
            "bytes */10"
        );
        let body_bytes = read_body(res.into_body()).await;
        assert!(body_bytes.is_empty());

        // Zero-length file unsatisfiable range
        let mut headers = HeaderMap::new();
        headers.insert(header::RANGE, "bytes=0-100".parse().unwrap());
        let res = server::serve_sound(
            AxumPath("empty.mp3".to_string()),
            headers,
            Extension(sound_dir.clone()),
        )
        .await
        .into_response();
        assert_eq!(res.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        assert_eq!(
            res.headers().get(header::CONTENT_RANGE).unwrap(),
            "bytes */0"
        );
        let body_bytes = read_body(res.into_body()).await;
        assert!(body_bytes.is_empty());

        // Directory rejection
        let headers = HeaderMap::new();
        let res = server::serve_sound(
            AxumPath("".to_string()),
            headers,
            Extension(sound_dir.clone()),
        )
        .await
        .into_response();
        assert_eq!(res.status(), StatusCode::NOT_FOUND);

        // Traversal rejection even when the escaped-to target exists
        let headers = HeaderMap::new();
        let res = server::serve_sound(
            AxumPath("../outside.mp3".to_string()),
            headers,
            Extension(sound_dir.clone()),
        )
        .await
        .into_response();
        assert_eq!(res.status(), StatusCode::NOT_FOUND);
        assert_ne!(read_body(res.into_body()).await, b"outside bytes");

        // A symlinked leaf cannot escape the retained descriptor.
        #[cfg(unix)]
        {
            let res = server::serve_sound(
                AxumPath("linked.mp3".to_string()),
                HeaderMap::new(),
                Extension(sound_dir.clone()),
            )
            .await
            .into_response();
            assert_eq!(res.status(), StatusCode::NOT_FOUND);
            assert_ne!(read_body(res.into_body()).await, b"outside bytes");
        }

        // A symlinked intermediate directory cannot escape the retained descriptor.
        #[cfg(unix)]
        {
            let res = server::serve_sound(
                AxumPath("link/x.mp3".to_string()),
                HeaderMap::new(),
                Extension(sound_dir.clone()),
            )
            .await
            .into_response();
            assert_eq!(res.status(), StatusCode::NOT_FOUND);
            assert_ne!(read_body(res.into_body()).await, b"escaped nested");
        }

        // Nested request keeps the audio content type from the requested leaf.
        let res = server::serve_sound(
            AxumPath("a/b.mp3".to_string()),
            HeaderMap::new(),
            Extension(sound_dir.clone()),
        )
        .await
        .into_response();
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(
            res.headers().get(header::CONTENT_TYPE).unwrap(),
            "audio/mpeg"
        );
        assert_eq!(read_body(res.into_body()).await, b"nested");

        // Missing file without loading full audio
        let headers = HeaderMap::new();
        let res = server::serve_sound(
            AxumPath("missing.mp3".to_string()),
            headers,
            Extension(sound_dir.clone()),
        )
        .await
        .into_response();
        assert_eq!(res.status(), StatusCode::NOT_FOUND);

        // Empty file
        let headers = HeaderMap::new();
        let res = server::serve_sound(
            AxumPath("empty.mp3".to_string()),
            headers,
            Extension(sound_dir.clone()),
        )
        .await
        .into_response();
        assert_eq!(res.status(), StatusCode::OK);
        let body_bytes = read_body(res.into_body()).await;
        assert!(body_bytes.is_empty());

        // A non-ENOENT open failure retains the public 404 mapping.
        #[cfg(unix)]
        if unsafe { libc::geteuid() } != 0 {
            use std::os::unix::fs::PermissionsExt;
            let denied_path = sound_path.join("denied.mp3");
            tokio::fs::write(&denied_path, b"denied bytes")
                .await
                .unwrap();
            std::fs::set_permissions(&denied_path, std::fs::Permissions::from_mode(0o000)).unwrap();
            let res = server::serve_sound(
                AxumPath("denied.mp3".to_string()),
                HeaderMap::new(),
                Extension(sound_dir),
            )
            .await
            .into_response();
            std::fs::set_permissions(&denied_path, std::fs::Permissions::from_mode(0o600)).unwrap();
            assert_eq!(res.status(), StatusCode::NOT_FOUND);
        }
    }

    #[test]
    fn serve_sound_error_paths_keep_diagnostics_and_never_panic() {
        use crate::infra::blocking::source_scan::body_at_indent;

        let source = include_str!("sound.rs");
        let body = body_at_indent(source, "pub(crate) async fn serve_sound(");
        assert!(!body.contains("unwrap("), "{body}");
        assert!(!body.contains("expect("), "{body}");
        assert!(body.contains("tokio::task::spawn_blocking"), "{body}");

        for needle in [
            "could not be opened",
            "filesystem task failed",
            "metadata failed",
            "seek failed",
        ] {
            let line = body
                .lines()
                .find(|line| line.contains(needle))
                .unwrap_or_else(|| panic!("missing diagnostic for {needle}: {body}"));
            assert!(line.contains("log::warn!"), "{line}");
            assert!(line.contains("path, error"), "{line}");
        }

        let join_arm = body
            .split_once("filesystem task failed")
            .expect("JoinError diagnostic")
            .1;
        assert!(
            join_arm.contains("StatusCode::INTERNAL_SERVER_ERROR"),
            "{join_arm}"
        );
    }
}
