//! Native Chess.com archive export.
//!
//! Archive discovery, validation, parsing, staging and publication all stay native.  The
//! renderer supplies only an opaque download destination and receives an opaque PGN artifact.

use crate::{
    error::Error,
    infra::{
        operations::RuntimeDownload,
        path_authority::{ArtifactPublication, PathRef},
    },
    progress::{
        begin_progress, complete_preserving_result, update_progress_with_state, ProgressLease,
        ProgressState,
    },
    AppState,
};
use chrono::Datelike;
use futures_util::StreamExt;
use serde::Deserialize;
use serde::Serialize;
use specta::Type;
#[cfg(test)]
use std::sync::{Arc, Mutex};
use std::{io::Write, time::Duration};
use tokio_util::sync::CancellationToken;

#[cfg(test)]
static STAGED_PGN_CAPTURE: Mutex<Option<Arc<Mutex<Vec<u8>>>>> = Mutex::new(None);

#[cfg(test)]
fn capture_staged_pgn_bytes(bytes: &[u8]) {
    if let Some(capture) = STAGED_PGN_CAPTURE.lock().unwrap().as_ref() {
        capture.lock().unwrap().extend_from_slice(bytes);
    }
}

const API_ORIGIN: &str = "https://api.chess.com";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const EXPORT_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const MAX_ARCHIVES: usize = 240;
const MAX_INDEX_BYTES: usize = 512 * 1024;
const MAX_ARCHIVE_BYTES: usize = 16 * 1024 * 1024;
const MAX_PGN_BYTES: usize = 100 * 1024 * 1024;
const MAX_PUBLIC_JSON_BYTES: usize = 1024 * 1024;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum ExportScope {
    Complete,
    Resumable,
}

#[derive(Clone, Copy)]
struct ExportLimits {
    timeout: Duration,
    pgn_bytes: usize,
    archives: usize,
}

impl Default for ExportLimits {
    fn default() -> Self {
        Self {
            timeout: EXPORT_TIMEOUT,
            pgn_bytes: MAX_PGN_BYTES,
            archives: MAX_ARCHIVES,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PublicChessComRequest {
    Account { player: String },
    Game { game_type: String, game_id: String },
}

#[derive(Deserialize)]
struct ArchiveIndex {
    archives: Vec<String>,
}

#[derive(Deserialize)]
struct ArchiveGames {
    games: Vec<ArchiveGame>,
}

#[derive(Deserialize)]
struct ArchiveGame {
    pgn: Option<String>,
    rules: Option<String>,
}

// Keep only rule sets the importer models.
const ACCOUNT_ARCHIVE_RULES: &[&str] = &["chess", "chess960"];

fn valid_player(player: &str) -> bool {
    !player.is_empty()
        && player.len() <= 50
        && player
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn archive_index_url(player: &str) -> Result<reqwest::Url, Error> {
    if !valid_player(player) {
        return Err(Error::InvalidInput("invalid Chess.com player name".into()));
    }
    let mut url = reqwest::Url::parse(API_ORIGIN)
        .map_err(|_| Error::InvalidInput("invalid Chess.com endpoint".into()))?;
    url.path_segments_mut()
        .map_err(|_| Error::InvalidInput("invalid Chess.com endpoint".into()))?
        .extend(["pub", "player", player, "games", "archives"]);
    Ok(url)
}

fn validate_archive_url(value: &str, player: &str) -> Result<(reqwest::Url, i32, u32), Error> {
    let url = reqwest::Url::parse(value)
        .map_err(|_| Error::InvalidInput("invalid Chess.com archive URL".into()))?;
    if url.scheme() != "https"
        || url.host_str() != Some("api.chess.com")
        || url.port_or_known_default() != Some(443)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(Error::InvalidInput(
            "untrusted Chess.com archive URL".into(),
        ));
    }
    let segments: Vec<_> = url
        .path_segments()
        .ok_or_else(|| Error::InvalidInput("invalid Chess.com archive URL".into()))?
        .collect();
    let ["pub", "player", archive_player, "games", year, month] = segments.as_slice() else {
        return Err(Error::InvalidInput(
            "untrusted Chess.com archive URL".into(),
        ));
    };
    if !archive_player.eq_ignore_ascii_case(player) {
        return Err(Error::InvalidInput(
            "Chess.com archive belongs to another player".into(),
        ));
    }
    let year = year
        .parse::<i32>()
        .map_err(|_| Error::InvalidInput("invalid Chess.com archive date".into()))?;
    let month = month
        .parse::<u32>()
        .map_err(|_| Error::InvalidInput("invalid Chess.com archive date".into()))?;
    if !(2007..=9999).contains(&year) || !(1..=12).contains(&month) {
        return Err(Error::InvalidInput("invalid Chess.com archive date".into()));
    }
    Ok((url, year, month))
}

async fn fetch_bounded(
    state: &AppState,
    url: reqwest::Url,
    max_bytes: usize,
    cancellation: &CancellationToken,
) -> Result<Vec<u8>, Error> {
    let response = tokio::select! {
        _ = cancellation.cancelled() => return Err(Error::Cancellation),
        response = tokio::time::timeout(REQUEST_TIMEOUT, state.http_transport.request(url.as_str(), reqwest::header::HeaderMap::new())) => {
            response.map_err(|_| Error::EngineTimeout("Chess.com request timed out".into()))??
        }
    };
    if !(200..300).contains(&response.status) {
        return Err(Error::RemoteHttpRejection(
            crate::error::RemoteHttpRejection {
                status: response.status,
                authorization_sent: false,
            },
        ));
    }
    if response
        .content_length
        .is_some_and(|length| length > max_bytes as u64)
    {
        return Err(Error::ResourceLimit(
            "Chess.com response is too large".into(),
        ));
    }
    let mut bytes = Vec::new();
    let mut stream = response.stream;
    while let Some(chunk) = tokio::select! {
        _ = cancellation.cancelled() => return Err(Error::Cancellation),
        chunk = stream.next() => chunk,
    } {
        let chunk = chunk?;
        if bytes.len().saturating_add(chunk.len()) > max_bytes {
            return Err(Error::ResourceLimit(
                "Chess.com response is too large".into(),
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn first_archive_month(since_ms: Option<i64>) -> Result<Option<(i32, u32)>, Error> {
    let Some(since_ms) = since_ms else {
        return Ok(None);
    };
    if since_ms < 0 {
        return Err(Error::InvalidInput(
            "invalid Chess.com export timestamp".into(),
        ));
    }
    let date = chrono::DateTime::from_timestamp_millis(since_ms)
        .ok_or_else(|| Error::InvalidInput("invalid Chess.com export timestamp".into()))?;
    Ok(Some((date.year(), date.month())))
}

#[tauri::command]
#[specta::specta]
pub async fn get_public_chess_com_json(
    request: PublicChessComRequest,
    state: tauri::State<'_, AppState>,
) -> Result<String, Error> {
    let url = match request {
        PublicChessComRequest::Account { player } => {
            if !valid_player(&player) {
                return Err(Error::InvalidInput("invalid Chess.com player name".into()));
            }
            let mut url = reqwest::Url::parse(API_ORIGIN)
                .map_err(|_| Error::InvalidInput("invalid Chess.com endpoint".into()))?;
            url.path_segments_mut()
                .map_err(|_| Error::InvalidInput("invalid Chess.com endpoint".into()))?
                .extend(["pub", "player", &player, "stats"]);
            url
        }
        PublicChessComRequest::Game { game_type, game_id } => {
            if !matches!(game_type.as_str(), "live" | "daily")
                || game_id.is_empty()
                || game_id.len() > 32
                || !game_id.bytes().all(|byte| byte.is_ascii_digit())
            {
                return Err(Error::InvalidInput("invalid Chess.com game".into()));
            }
            let mut url = reqwest::Url::parse("https://www.chess.com")
                .map_err(|_| Error::InvalidInput("invalid Chess.com endpoint".into()))?;
            url.path_segments_mut()
                .map_err(|_| Error::InvalidInput("invalid Chess.com endpoint".into()))?
                .extend(["callback", &game_type, "game", &game_id]);
            url
        }
    };
    let bytes = fetch_bounded(
        state.inner(),
        url,
        MAX_PUBLIC_JSON_BYTES,
        &CancellationToken::new(),
    )
    .await?;
    serde_json::from_slice::<serde_json::Value>(&bytes)
        .map_err(|_| Error::InvalidInput("Chess.com returned invalid JSON".into()))?;
    String::from_utf8(bytes)
        .map_err(|_| Error::InvalidInput("Chess.com returned invalid UTF-8".into()))
}

#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)]
pub async fn download_chess_com_games(
    destination: PathRef,
    filename: String,
    player: String,
    since_ms: Option<i64>,
    job_id: String,
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> Result<ArtifactPublication, Error> {
    crate::fs::download_publication_result(
        download_chess_com_games_runtime(
            destination,
            filename,
            player,
            since_ms,
            job_id,
            app,
            window.label(),
            state.inner().clone(),
            ExportScope::Complete,
            true,
        )
        .await,
    )
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn download_chess_com_games_runtime<R: tauri::Runtime>(
    destination: PathRef,
    filename: String,
    player: String,
    since_ms: Option<i64>,
    job_id: String,
    app: tauri::AppHandle<R>,
    owner: &str,
    state: AppState,
    scope: ExportScope,
    fail_progress_on_receipt_error: bool,
) -> Result<RuntimeDownload, Error> {
    let admission_key = format!("chesscom_{}", player.to_ascii_lowercase());
    let lease = state.operations.claim_download(
        &job_id,
        owner,
        "download_chess_com_games",
        &job_id,
        &admission_key,
        true,
        crate::fs::MAX_ACTIVE_DOWNLOADS,
    )?;
    let lower_player = player.to_ascii_lowercase();
    let first_month = first_archive_month(since_ms)?;
    let cancellation = lease.token();
    let commit_gate = lease.commit_gate();
    crate::infra::operations::run_native_operation(
        lease,
        "download_chess_com_games",
        download_chess_com_games_core(
            destination,
            filename,
            job_id,
            lower_player,
            first_month,
            app,
            state,
            cancellation,
            commit_gate,
            ExportLimits::default(),
            scope,
            fail_progress_on_receipt_error,
        ),
    )
    .await
}

fn report_terminal_progress<R: tauri::Runtime>(
    state: &AppState,
    app: &tauri::AppHandle<R>,
    progress: &ProgressLease,
    terminal: ProgressState,
) {
    let value = if matches!(terminal, ProgressState::Succeeded) {
        100.0
    } else {
        0.0
    };
    if let Err(error) =
        update_progress_with_state(&state.progress_state, app, progress, value, terminal)
    {
        log::warn!(
            "Chess.com export terminal progress generation {} failed: {}",
            progress.generation,
            error.category()
        );
    }
}

// This core mirrors the accepted command boundary: destination authority, request identity,
// progress owner, cancellation owner and deadline are intentionally explicit and independently
// validated before publication.
#[allow(clippy::too_many_arguments)]
async fn download_chess_com_games_core<R: tauri::Runtime>(
    destination: PathRef,
    filename: String,
    job_id: String,
    lower_player: String,
    first_month: Option<(i32, u32)>,
    app: tauri::AppHandle<R>,
    state: AppState,
    cancellation: CancellationToken,
    commit_gate: crate::infra::operations::OperationCommitGate,
    limits: ExportLimits,
    scope: ExportScope,
    fail_progress_on_receipt_error: bool,
) -> Result<RuntimeDownload, Error> {
    if cancellation.is_cancelled() {
        return Err(Error::Cancellation);
    }
    let progress = begin_progress(&state.progress_state, &app, job_id)?;

    let result = async {
        let deadline = tokio::time::Instant::now() + limits.timeout;
        let archives = tokio::time::timeout_at(deadline, async {
            let index_bytes = fetch_bounded(
                &state,
                archive_index_url(&lower_player)?,
                MAX_INDEX_BYTES,
                &cancellation,
            )
            .await?;
            let index: ArchiveIndex = serde_json::from_slice(&index_bytes).map_err(|_| {
                Error::InvalidInput("Chess.com returned an invalid archive index".into())
            })?;
            if scope == ExportScope::Complete && index.archives.len() > limits.archives {
                return Err(Error::ResourceLimit("too many Chess.com archives".into()));
            }
            let mut archives = index
                .archives
                .iter()
                .map(|archive| validate_archive_url(archive, &lower_player))
                .collect::<Result<Vec<_>, _>>()?;
            archives.sort_by_key(|(_, year, month)| (*year, *month));
            archives.dedup_by_key(|(_, year, month)| (*year, *month));
            if let Some(first_month) = first_month {
                archives.retain(|(_, year, month)| (*year, *month) >= first_month);
            }
            if archives.is_empty() {
                return Err(Error::InvalidInput(
                    "Chess.com returned no requested archives".into(),
                ));
            }

            Ok::<_, Error>(archives)
        })
        .await
        .map_err(|_| export_deadline_error())??;

        // Each temporary file is one complete month. A deadline can drop an in-flight month
        // without losing the prefix or exposing a partially written archive.
        let mut months = Vec::new();
        let mut total_pgn_bytes = 0usize;
        let mut last_month = None;
        let mut stopped = false;
        let total = archives.len();
        for (index, (archive, year, month)) in archives.into_iter().enumerate() {
            if scope == ExportScope::Resumable && index >= limits.archives {
                stopped = true;
                break;
            }
            let token = cancellation.clone();
            let staged_month = tokio::time::timeout_at(deadline, async {
                let bytes =
                    fetch_bounded(&state, archive, MAX_ARCHIVE_BYTES, &cancellation).await?;
                crate::infra::blocking::BLOCKING_GATEWAY
                    .spawn_cancellable(token, move |token| {
                        let games: ArchiveGames = serde_json::from_slice(&bytes).map_err(|_| {
                            Error::InvalidInput("Chess.com returned an invalid game archive".into())
                        })?;
                        if games.games.is_empty() {
                            return Err(Error::InvalidInput(
                                "Chess.com returned an empty requested game archive".into(),
                            ));
                        }
                        let mut staged = tempfile::NamedTempFile::new()?;
                        let mut month_bytes = 0usize;
                        for game in games.games {
                            if token.is_cancelled() {
                                return Err(Error::Cancellation);
                            }
                            if game
                                .rules
                                .as_deref()
                                .is_some_and(|rules| !ACCOUNT_ARCHIVE_RULES.contains(&rules))
                            {
                                continue;
                            }
                            let pgn =
                                game.pgn
                                    .filter(|pgn| !pgn.trim().is_empty())
                                    .ok_or_else(|| {
                                        Error::InvalidInput(
                                            "Chess.com returned a game without PGN".into(),
                                        )
                                    })?;
                            month_bytes = month_bytes.saturating_add(pgn.len()).saturating_add(1);
                            if total_pgn_bytes.saturating_add(month_bytes) > limits.pgn_bytes {
                                return Ok(None);
                            }
                            staged.write_all(pgn.as_bytes())?;
                            #[cfg(test)]
                            capture_staged_pgn_bytes(pgn.as_bytes());
                            staged.write_all(b"\n")?;
                            #[cfg(test)]
                            capture_staged_pgn_bytes(b"\n");
                        }
                        staged.flush()?;
                        Ok(Some((staged, month_bytes)))
                    })
                    .await
            })
            .await;
            let (staged, month_bytes) = match staged_month {
                Ok(Ok(Some(month))) => month,
                Ok(Ok(None)) if scope == ExportScope::Resumable && !months.is_empty() => {
                    stopped = true;
                    break;
                }
                Ok(Ok(None)) => {
                    return Err(Error::ResourceLimit(
                        "Chess.com PGN export is too large".into(),
                    ))
                }
                Ok(Err(error)) => return Err(error),
                Err(_) if scope == ExportScope::Resumable && !months.is_empty() => {
                    stopped = true;
                    break;
                }
                Err(_) => return Err(export_deadline_error()),
            };
            months.push(staged);
            total_pgn_bytes += month_bytes;
            last_month = Some((year, month));
            update_progress_with_state(
                &state.progress_state,
                &app,
                &progress,
                ((index + 1) as f32 / total as f32) * 90.0,
                ProgressState::Running,
            )?;
        }
        if months.is_empty() {
            return Err(Error::ResourceLimit("too many Chess.com archives".into()));
        }
        let coverage_floor_ms = if stopped {
            last_month.map(next_month_floor).transpose()?
        } else {
            None
        };
        let staged = crate::infra::blocking::BLOCKING_GATEWAY
            .spawn_cancellable(cancellation.clone(), move |token| {
                use std::io::{Seek, SeekFrom};
                let mut staged = tempfile::NamedTempFile::new()?;
                for mut month in months {
                    if token.is_cancelled() {
                        return Err(Error::Cancellation);
                    }
                    month.seek(SeekFrom::Start(0))?;
                    std::io::copy(&mut month, &mut staged)?;
                }
                staged.flush()?;
                Ok(staged)
            })
            .await?;

        // Publication and its durability/activation tail are deliberately outside the staging
        // timeout. Once installation starts, cancellation checkpoints decide whether publication
        // is still safe; after rename, the real durability and activation outcome always wins.
        let publication = crate::fs::install_staged_pgn_artifact(
            destination,
            filename,
            staged,
            &state,
            &cancellation,
            Some(&commit_gate),
        )
        .await?;
        let since_ms = first_month
            .and_then(|(year, month)| chrono::NaiveDate::from_ymd_opt(year, month, 1))
            .and_then(|date| date.and_hms_opt(0, 0, 0))
            .map(|date| date.and_utc().timestamp_millis());
        let receipt_error = crate::db::linked_collections::record_download_receipt(
            &state.pgn_path_authority,
            publication.handle.clone(),
            "chesscom",
            &lower_player,
            since_ms,
            None,
            coverage_floor_ms,
            cancellation.clone(),
        )
        .await;
        Ok(RuntimeDownload {
            publication,
            receipt_error,
            coverage_holds: None,
            coverage_floor_ms,
        })
    }
    .await;

    let receipt_failed = result
        .as_ref()
        .is_ok_and(|downloaded| downloaded.receipt_error.is_some());
    complete_preserving_result(result, |terminal| {
        let terminal = if fail_progress_on_receipt_error && receipt_failed {
            ProgressState::Failed
        } else {
            terminal
        };
        report_terminal_progress(&state, &app, &progress, terminal)
    })
}

fn export_deadline_error() -> Error {
    Error::EngineTimeout("Chess.com export deadline exceeded".into())
}

fn next_month_floor((year, month): (i32, u32)) -> Result<i64, Error> {
    let (year, month) = if month == 12 {
        (year + 1, 1)
    } else {
        (year, month + 1)
    };
    chrono::NaiveDate::from_ymd_opt(year, month, 1)
        .and_then(|date| date.and_hms_opt(0, 0, 0))
        .map(|date| date.and_utc().timestamp_millis())
        .ok_or_else(|| Error::InvalidInput("invalid Chess.com archive date".into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infra::blocking::source_scan::body_at_indent;
    use crate::infra::net::{DownloadResponse, DownloadTransport};
    use async_trait::async_trait;
    use bytes::Bytes;
    use reqwest::header::HeaderMap;
    use std::{
        collections::VecDeque,
        path::PathBuf,
        sync::{
            atomic::{AtomicUsize, Ordering},
            Arc, Mutex,
        },
    };

    struct MockTransport {
        response: Mutex<Option<DownloadResponse>>,
        requests: Mutex<Vec<String>>,
    }

    #[async_trait]
    impl DownloadTransport for MockTransport {
        async fn request(&self, url: &str, headers: HeaderMap) -> Result<DownloadResponse, Error> {
            assert!(headers.is_empty());
            self.requests.lock().unwrap().push(url.into());
            self.response
                .lock()
                .unwrap()
                .take()
                .ok_or_else(|| Error::InvalidInput("unexpected request".into()))
        }
    }

    fn response(body: &'static [u8]) -> DownloadResponse {
        DownloadResponse {
            status: 200,
            headers: HeaderMap::new(),
            content_length: Some(body.len() as u64),
            stream: Box::pin(futures_util::stream::iter(vec![Ok(Bytes::from_static(
                body,
            ))])),
        }
    }

    const INDEX: &[u8] =
        br#"{"archives":["https://api.chess.com/pub/player/felix/games/2026/09"]}"#;
    const ARCHIVE: &[u8] = br#"{"games":[{"pgn":"1. e4 e5"}]}"#;

    // Hang guard, not a latency assertion. Hosted Windows runners stall for tens of seconds
    // (43 s in CI run 42011942850), so durable I/O needs a bound far above those stalls.
    const TERMINAL_HANG_GUARD: Duration = Duration::from_secs(120);
    // Sleep between polls of native state, so a waiting test does not spin a core.
    const TEST_POLL_INTERVAL: Duration = Duration::from_millis(5);

    struct ExportTransport {
        responses: Mutex<VecDeque<DownloadResponse>>,
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn linked_collections_overlapping_months_append_genuine_transport_artifacts_once() {
        use crate::db::linked_collections::tests::{game, Fixture};
        use crate::file_workspace::WorkspaceFileType;
        fn json_response(value: serde_json::Value) -> DownloadResponse {
            let bytes = serde_json::to_vec(&value).unwrap();
            DownloadResponse {
                status: 200,
                headers: HeaderMap::new(),
                content_length: Some(bytes.len() as u64),
                stream: Box::pin(futures_util::stream::iter(vec![Ok(Bytes::from(bytes))])),
            }
        }
        let fixture = Fixture::new();
        let original = game(
            None,
            "e4 e5",
            "user annotation survives the provider overlap",
        );
        fixture.create("history", &original, WorkspaceFileType::Game);
        let collection = fixture.list().pop().unwrap();
        fixture.account(&collection.id, "chesscom");
        let first = game(Some("123"), "e4 e5", "provider annotation");
        let second = game(Some("456"), "d4 d5", "equal timestamp");
        let third = game(Some("789"), "c4 c5", "same timestamp, later arrival");
        let transport = Arc::new(ExportTransport {
            responses: Mutex::new(VecDeque::from([
                json_response(
                    serde_json::json!({"archives":["https://api.chess.com/pub/player/player/games/2026/09","https://api.chess.com/pub/player/player/games/2026/10"]}),
                ),
                json_response(serde_json::json!({"games":[{"pgn":first}]})),
                json_response(serde_json::json!({"games":[{"pgn":first},{"pgn":second}]})),
                json_response(
                    serde_json::json!({"archives":["https://api.chess.com/pub/player/player/games/2026/09","https://api.chess.com/pub/player/player/games/2026/10"]}),
                ),
                json_response(serde_json::json!({"games":[{"pgn":second},{"pgn":third}]})),
            ])),
        });
        let state = AppState {
            http_transport: transport.clone(),
            ..fixture.state.clone()
        };
        let app = fixture.app();
        for (first_month, expected) in [(None, 1), (Some((2026, 10)), 1)] {
            let job = state.operations.prepare_download("test").unwrap();
            let lease = state
                .operations
                .claim_download(
                    &job,
                    "test",
                    "download_chess_com_games",
                    &job,
                    "chesscom_player",
                    true,
                    crate::fs::MAX_ACTIVE_DOWNLOADS,
                )
                .unwrap();
            let token = lease.token();
            let gate = lease.commit_gate();
            let publication = crate::infra::operations::run_native_operation(
                lease,
                "download_chess_com_games",
                download_chess_com_games_core(
                    fixture.download_destination(),
                    "player.pgn".into(),
                    job,
                    "player".into(),
                    first_month,
                    app.handle().clone(),
                    state.clone(),
                    token,
                    gate,
                    ExportLimits {
                        timeout: Duration::from_secs(30),
                        ..ExportLimits::default()
                    },
                    ExportScope::Complete,
                    true,
                ),
            )
            .await
            .unwrap();
            assert!(publication.receipt_error.is_none());
            let publication = publication.publication;
            let result = Arc::clone(&fixture.service)
                .append_batch(
                    state.pgn_path_authority.clone(),
                    uuid::Uuid::parse_str(&collection.id).unwrap(),
                    publication.handle,
                    CancellationToken::new(),
                )
                .await
                .unwrap();
            assert_eq!(result.appended, expected);
            assert!(result.index_ready);
        }
        let bytes = std::fs::read_to_string(fixture.path("history")).unwrap();
        assert!(bytes.starts_with(&original));
        assert_eq!(bytes.matches("[Event ").count(), 3);
        assert_eq!(bytes.matches("/456\"").count(), 1);
        assert_eq!(bytes.matches("/789\"").count(), 1);
        assert!(fixture.list()[0].fetch_since_ms.is_some(), "a completed full-history provider export did not establish an inclusive coverage cursor");
        assert!(
            transport.responses.lock().unwrap().is_empty(),
            "the inclusive latest month was not fetched through the real transport"
        );
    }

    #[async_trait]
    impl DownloadTransport for ExportTransport {
        async fn request(&self, _: &str, _: HeaderMap) -> Result<DownloadResponse, Error> {
            self.responses
                .lock()
                .unwrap()
                .pop_front()
                .ok_or_else(|| Error::InvalidInput("unexpected request".into()))
        }
    }

    struct HeldArchiveTransport {
        requests: AtomicUsize,
        entered: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
        release: tokio::sync::Notify,
    }

    #[async_trait]
    impl DownloadTransport for HeldArchiveTransport {
        async fn request(&self, _: &str, _: HeaderMap) -> Result<DownloadResponse, Error> {
            if self.requests.fetch_add(1, Ordering::SeqCst) == 0 {
                return Ok(response(INDEX));
            }
            if let Some(entered) = self.entered.lock().unwrap().take() {
                let _ = entered.send(());
            }
            self.release.notified().await;
            Ok(response(ARCHIVE))
        }
    }

    struct ResetAtomicInjector;

    impl Drop for ResetAtomicInjector {
        fn drop(&mut self) {
            crate::infra::fs::set_test_atomic_file_injector(None);
        }
    }

    struct HoldAtomicPoint {
        point: crate::infra::fs::AtomicFileFaultPoint,
        occurrence: usize,
        seen: AtomicUsize,
        entered: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
        release: Mutex<std::sync::mpsc::Receiver<()>>,
        fail_after_release: bool,
    }

    impl crate::infra::fs::AtomicWriterInjector for HoldAtomicPoint {
        fn inject(&self, point: crate::infra::fs::AtomicFileFaultPoint) -> std::io::Result<()> {
            if point == self.point && self.seen.fetch_add(1, Ordering::SeqCst) == self.occurrence {
                if let Some(entered) = self.entered.lock().unwrap().take() {
                    let _ = entered.send(());
                }
                self.release.lock().unwrap().recv().map_err(|_| {
                    std::io::Error::other("test publication release sender dropped")
                })?;
                if self.fail_after_release {
                    return Err(std::io::Error::other("injected publication failure"));
                }
            }
            Ok(())
        }
    }

    fn export_transport() -> Arc<dyn DownloadTransport> {
        Arc::new(ExportTransport {
            responses: Mutex::new(VecDeque::from([response(INDEX), response(ARCHIVE)])),
        })
    }

    fn hold_atomic_point(
        point: crate::infra::fs::AtomicFileFaultPoint,
        occurrence: usize,
        fail_after_release: bool,
    ) -> (
        tokio::sync::oneshot::Receiver<()>,
        std::sync::mpsc::SyncSender<()>,
    ) {
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::sync_channel(1);
        crate::infra::fs::set_test_atomic_file_injector(Some(Arc::new(HoldAtomicPoint {
            point,
            occurrence,
            seen: AtomicUsize::new(0),
            entered: Mutex::new(Some(entered_tx)),
            release: Mutex::new(release_rx),
            fail_after_release,
        })));
        (entered_rx, release_tx)
    }

    fn export_fixture(
        transport: Arc<dyn DownloadTransport>,
    ) -> (
        tempfile::TempDir,
        AppState,
        PathRef,
        PathBuf,
        tauri::App<tauri::test::MockRuntime>,
    ) {
        let dir = tempfile::tempdir().unwrap();
        let app_root = crate::infra::path_authority::AppOwnedRoot::canonical_for_test(
            "downloads",
            &dir.path().join("downloads"),
            vec![crate::infra::path_authority::PathOperation::DownloadFile],
        );
        let download_root = app_root.path.clone();
        let destination = app_root.id.clone();
        let authority = crate::infra::path_authority::PathAuthority::open(
            dir.path().join("path-authority.json"),
            vec![app_root],
        )
        .unwrap();
        let state = AppState {
            http_transport: transport,
            ..Default::default()
        };
        state.pgn_path_authority.install(authority).unwrap();
        let app = tauri::test::mock_app();
        tauri_specta::Builder::<tauri::test::MockRuntime>::new()
            .events(tauri_specta::collect_events!(
                crate::progress::ProgressEvent
            ))
            .mount_events(&app);
        (dir, state, destination, download_root, app)
    }

    #[tokio::test]
    async fn chesscom_failed_export_has_no_payload() {
        struct FailureTransport(bool);
        #[async_trait]
        impl DownloadTransport for FailureTransport {
            async fn request(&self, _: &str, _: HeaderMap) -> Result<DownloadResponse, Error> {
                if self.0 {
                    Err(Error::Cancellation)
                } else {
                    Err(Error::RemoteHttpRejection(
                        crate::error::RemoteHttpRejection {
                            status: 403,
                            authorization_sent: false,
                        },
                    ))
                }
            }
        }
        for cancelled in [false, true] {
            let (_dir, state, destination, root, app) =
                export_fixture(Arc::new(FailureTransport(cancelled)));
            let job = state.operations.prepare_download("test").unwrap();
            let result = download_chess_com_games_runtime(
                destination,
                "failed.pgn".into(),
                "felix".into(),
                None,
                job.clone(),
                app.handle().clone(),
                "test",
                state.clone(),
                ExportScope::Complete,
                true,
            )
            .await;
            let runtime_error = result.as_ref().unwrap_err();
            assert!(serde_json::to_value(runtime_error)
                .unwrap()
                .get("progressGeneration")
                .is_none());
            let command_error = crate::fs::download_publication_result(result).unwrap_err();
            assert!(serde_json::to_value(&command_error)
                .unwrap()
                .get("progressGeneration")
                .is_none());
            assert_eq!(matches!(command_error, Error::Cancellation), cancelled);
            let item = state.progress_state.get(&job).unwrap().unwrap();
            assert_eq!(
                item.state,
                if cancelled {
                    ProgressState::Cancelled
                } else {
                    ProgressState::Failed
                }
            );
            assert!(item.finished);
            assert!(item.failure.is_none());
            assert!(serde_json::to_value(item).unwrap().get("failure").is_none());
            assert!(!root.join("failed.pgn").exists());
        }
    }

    async fn run_owned_export(
        destination: PathRef,
        filename: String,
        job_id: String,
        app: tauri::AppHandle<tauri::test::MockRuntime>,
        state: AppState,
        timeout: Duration,
    ) -> Result<RuntimeDownload, Error> {
        run_export_with_limits(
            destination,
            filename,
            job_id,
            app,
            state,
            None,
            ExportScope::Complete,
            ExportLimits {
                timeout,
                ..ExportLimits::default()
            },
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    async fn run_export_with_limits(
        destination: PathRef,
        filename: String,
        job_id: String,
        app: tauri::AppHandle<tauri::test::MockRuntime>,
        state: AppState,
        first_month: Option<(i32, u32)>,
        scope: ExportScope,
        limits: ExportLimits,
    ) -> Result<RuntimeDownload, Error> {
        let lease = state.operations.claim_download(
            &job_id,
            "test",
            "download_chess_com_games",
            &job_id,
            &job_id,
            false,
            crate::fs::MAX_ACTIVE_DOWNLOADS,
        )?;
        let cancellation = lease.token();
        let commit_gate = lease.commit_gate();
        crate::infra::operations::run_native_operation(
            lease,
            "download_chess_com_games",
            download_chess_com_games_core(
                destination,
                filename,
                job_id,
                "felix".into(),
                first_month,
                app,
                state,
                cancellation,
                commit_gate,
                limits,
                scope,
                true,
            ),
        )
        .await
    }

    const TWO_MONTHS: &[u8] = br#"{"archives":["https://api.chess.com/pub/player/felix/games/2026/09","https://api.chess.com/pub/player/felix/games/2026/10"]}"#;

    #[tokio::test]
    async fn resumable_limits_publish_whole_prefix_and_complete_scope_preserves_destination() {
        for count_limit in [false, true] {
            for scope in [ExportScope::Complete, ExportScope::Resumable] {
                let transport = Arc::new(ExportTransport {
                    responses: Mutex::new(VecDeque::from([
                        response(TWO_MONTHS),
                        response(ARCHIVE),
                        response(br#"{"games":[{"pgn":"1. d4 d5"},{"pgn":"1. c4 c5"}]}"#),
                    ])),
                });
                let (_dir, state, destination, root, app) = export_fixture(transport);
                std::fs::write(root.join("bounded.pgn"), b"previous").unwrap();
                let job = state.operations.prepare_download("test").unwrap();
                let limits = ExportLimits {
                    pgn_bytes: if count_limit { MAX_PGN_BYTES } else { 20 },
                    archives: if count_limit { 1 } else { MAX_ARCHIVES },
                    ..ExportLimits::default()
                };
                let result = run_export_with_limits(
                    destination,
                    "bounded.pgn".into(),
                    job,
                    app.handle().clone(),
                    state,
                    None,
                    scope,
                    limits,
                )
                .await;
                if scope == ExportScope::Complete {
                    assert!(matches!(result, Err(Error::ResourceLimit(_))));
                    assert_eq!(
                        std::fs::read(root.join("bounded.pgn")).unwrap(),
                        b"previous"
                    );
                } else {
                    let result = result.unwrap();
                    assert_eq!(
                        result.coverage_floor_ms,
                        Some(next_month_floor((2026, 9)).unwrap())
                    );
                    assert_eq!(
                        std::fs::read(root.join("bounded.pgn")).unwrap(),
                        b"1. e4 e5\n"
                    );
                }
            }
        }
    }

    struct SlowMonths {
        served_in_export: AtomicUsize,
        completed: Mutex<Vec<String>>,
        before_first: bool,
    }

    #[async_trait]
    impl DownloadTransport for SlowMonths {
        async fn request(&self, url: &str, _: HeaderMap) -> Result<DownloadResponse, Error> {
            if url.ends_with("archives") {
                self.served_in_export.store(0, Ordering::SeqCst);
                return Ok(response(TWO_MONTHS));
            }
            let index = self.served_in_export.fetch_add(1, Ordering::SeqCst);
            if self.before_first || index > 0 {
                std::future::pending::<()>().await;
            }
            self.completed.lock().unwrap().push(url.to_owned());
            Ok(response(ARCHIVE))
        }
    }

    #[tokio::test]
    async fn resumable_deadline_advances_months_without_refetching_completed_months() {
        let transport = Arc::new(SlowMonths {
            served_in_export: AtomicUsize::new(0),
            completed: Mutex::new(Vec::new()),
            before_first: false,
        });
        let (_dir, state, destination, root, app) = export_fixture(transport.clone());
        let mut since = None;
        let mut floors = Vec::new();
        for _ in 0..2 {
            let job = state.operations.prepare_download("test").unwrap();
            let result = run_export_with_limits(
                destination.clone(),
                "slow.pgn".into(),
                job,
                app.handle().clone(),
                state.clone(),
                first_archive_month(since).unwrap(),
                ExportScope::Resumable,
                ExportLimits {
                    timeout: Duration::from_millis(500),
                    ..ExportLimits::default()
                },
            )
            .await
            .unwrap();
            floors.push(result.coverage_floor_ms);
            since = Some(crate::db::linked_collections::account_sync_cursor(
                "chesscom",
                since,
                Some(1),
                &Default::default(),
                None,
                result.coverage_floor_ms,
            ));
            assert_eq!(std::fs::read(root.join("slow.pgn")).unwrap(), b"1. e4 e5\n");
        }
        assert_eq!(
            floors,
            vec![Some(next_month_floor((2026, 9)).unwrap()), None]
        );
        {
            let completed = transport.completed.lock().unwrap();
            assert_eq!(completed.len(), 2);
            assert!(completed[0].ends_with("/2026/09"));
            assert!(completed[1].ends_with("/2026/10"));
        }
        let transport = Arc::new(SlowMonths {
            served_in_export: AtomicUsize::new(0),
            completed: Mutex::new(Vec::new()),
            before_first: true,
        });
        let (_dir, state, destination, root, app) = export_fixture(transport);
        std::fs::write(root.join("slow.pgn"), b"previous").unwrap();
        let job = state.operations.prepare_download("test").unwrap();
        let result = run_export_with_limits(
            destination,
            "slow.pgn".into(),
            job,
            app.handle().clone(),
            state,
            None,
            ExportScope::Resumable,
            ExportLimits {
                timeout: Duration::from_millis(100),
                ..ExportLimits::default()
            },
        )
        .await;
        assert!(matches!(result, Err(Error::EngineTimeout(_))));
        assert_eq!(std::fs::read(root.join("slow.pgn")).unwrap(), b"previous");
    }

    #[tokio::test]
    async fn resumable_filtered_month_publishes_empty_prefix_with_floor() {
        let transport = Arc::new(ExportTransport {
            responses: Mutex::new(VecDeque::from([
                response(TWO_MONTHS),
                response(br#"{"games":[{"rules":"crazyhouse","pgn":"1. N@f3 *"}]}"#),
            ])),
        });
        let (_dir, state, destination, root, app) = export_fixture(transport);
        let job = state.operations.prepare_download("test").unwrap();
        let result = run_export_with_limits(
            destination,
            "empty.pgn".into(),
            job,
            app.handle().clone(),
            state,
            None,
            ExportScope::Resumable,
            ExportLimits {
                archives: 1,
                ..ExportLimits::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(
            result.coverage_floor_ms,
            Some(next_month_floor((2026, 9)).unwrap())
        );
        assert!(std::fs::read(root.join("empty.pgn")).unwrap().is_empty());
    }

    #[tokio::test]
    async fn staging_keeps_only_supported_rules_and_absent_rules() {
        let archive = br#"{"games":[{"rules":"chess","pgn":"[Event \"standard\"]\n\n1. e4 e5 *\n"},{"rules":"chess960","pgn":"[Event \"chess960\"]\n\n1. d4 d5 *\n"},{"rules":"crazyhouse","pgn":"[Event \"crazyhouse\"]\n\n1. N@f3 *\n"},{"rules":"bughouse","pgn":"[Event \"bughouse\"]\n\n1. P@e4 *\n"},{"rules":"kingofthehill","pgn":"[Event \"kingofthehill\"]\n\n1. e4 e5 *\n"},{"pgn":"[Event \"absent-rules\"]\n\n1. c4 c5 *\n"}]}"#;
        let transport = Arc::new(ExportTransport {
            responses: Mutex::new(VecDeque::from([response(INDEX), response(archive)])),
        });
        let (_dir, state, destination, root, app) = export_fixture(transport);
        let job = state.operations.prepare_download("test").unwrap();
        let downloaded = run_owned_export(
            destination,
            "filtered.pgn".into(),
            job,
            app.handle().clone(),
            state,
            Duration::from_secs(30),
        )
        .await
        .unwrap();
        assert!(downloaded.receipt_error.is_none());
        let staged = std::fs::read_to_string(root.join("filtered.pgn")).unwrap();
        for expected in [
            "[Event \"standard\"]\n\n1. e4 e5 *\n",
            "[Event \"chess960\"]\n\n1. d4 d5 *\n",
            "[Event \"absent-rules\"]\n\n1. c4 c5 *\n",
        ] {
            assert!(staged.contains(expected), "missing staged game: {expected}");
        }
        for excluded in ["crazyhouse", "N@f3", "bughouse", "P@e4", "kingofthehill"] {
            assert!(
                !staged.contains(excluded),
                "staged excluded game: {excluded}"
            );
        }
        assert_eq!(staged.matches("[Event ").count(), 3);
    }

    #[tokio::test]
    async fn staging_only_variant_games_publishes_readable_empty_pgn() {
        for archive in [
            br#"{"games":[{"rules":"crazyhouse","pgn":"[Event \"crazyhouse\"]\n\n1. N@f3 *\n"},{"rules":"bughouse","pgn":"[Event \"bughouse\"]\n\n1. P@e4 *\n"}]}"#.as_slice(),
            br#"{"games":[{"rules":"crazyhouse"},{"rules":"bughouse","pgn":""}]}"#.as_slice(),
        ] {
            let transport = Arc::new(ExportTransport {
                responses: Mutex::new(VecDeque::from([response(INDEX), response(archive)])),
            });
            let (_dir, state, destination, root, app) = export_fixture(transport);
            let job = state.operations.prepare_download("test").unwrap();
            let downloaded = run_owned_export(
                destination,
                "empty.pgn".into(),
                job,
                app.handle().clone(),
                state.clone(),
                Duration::from_secs(30),
            )
            .await
            .unwrap();
            assert!(downloaded.receipt_error.is_none());
            assert!(state
                .pgn_path_authority
                .raw_for_test()
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .has_persistent_id(&downloaded.publication.handle.id.id));
            let staged = std::fs::read(root.join("empty.pgn")).unwrap();
            assert_eq!(
                staged.len(),
                0,
                "variant-only publication must have zero bytes"
            );
        }
    }

    async fn wait_for_progress(state: &AppState, job_id: &str, expected: ProgressState) {
        tokio::time::timeout(TERMINAL_HANG_GUARD, async {
            loop {
                if state
                    .progress_state
                    .get(job_id)
                    .unwrap()
                    .is_some_and(|item| item.state == expected)
                {
                    return;
                }
                tokio::time::sleep(TEST_POLL_INTERVAL).await;
            }
        })
        .await
        .unwrap_or_else(|_| {
            panic!("job {job_id} did not reach {expected:?} within {TERMINAL_HANG_GUARD:?}")
        });
    }

    async fn wait_for_operation_drain(state: &AppState) {
        tokio::time::timeout(TERMINAL_HANG_GUARD, async {
            loop {
                if state.operations.outstanding_labels().unwrap().is_empty() {
                    return;
                }
                tokio::time::sleep(TEST_POLL_INTERVAL).await;
            }
        })
        .await
        .unwrap_or_else(|_| {
            panic!(
                "operations did not drain within {TERMINAL_HANG_GUARD:?}, remaining outstanding_labels: {:?}",
                state.operations.outstanding_labels()
            )
        });
    }

    #[test]
    fn archive_urls_are_exactly_constrained_to_the_requested_player_and_month() {
        let (url, year, month) = validate_archive_url(
            "https://api.chess.com/pub/player/Felix_Chess/games/2025/09",
            "felix_chess",
        )
        .unwrap();
        assert_eq!(url.host_str(), Some("api.chess.com"));
        assert_eq!((year, month), (2025, 9));
        for invalid in [
            "https://evil.example/pub/player/felix_chess/games/2025/09",
            "https://api.chess.com/pub/player/other/games/2025/09",
            "https://api.chess.com/pub/player/felix_chess/games/2025/09?token=x",
            "http://api.chess.com/pub/player/felix_chess/games/2025/09",
        ] {
            assert!(validate_archive_url(invalid, "felix_chess").is_err());
        }
    }

    #[test]
    fn export_timestamp_selects_the_first_inclusive_month() {
        assert_eq!(
            first_archive_month(Some(1_725_148_800_000)).unwrap(),
            Some((2024, 9))
        );
        assert!(first_archive_month(Some(-1)).is_err());
    }

    #[tokio::test]
    async fn remote_http_rejection_is_anonymous_and_never_polls_body() {
        for (status, category) in [
            (301, "network"),
            (400, "network"),
            (401, "authentication"),
            (403, "permission"),
            (404, "missing-resource"),
            (429, "network"),
            (500, "network"),
            (503, "network"),
        ] {
            let polls = Arc::new(AtomicUsize::new(0));
            let body_polls = polls.clone();
            let transport = Arc::new(MockTransport {
                response: Mutex::new(Some(DownloadResponse {
                    status,
                    headers: HeaderMap::new(),
                    content_length: Some(u64::MAX),
                    stream: Box::pin(futures_util::stream::poll_fn(move |_| {
                        body_polls.fetch_add(1, Ordering::SeqCst);
                        std::task::Poll::Ready(Some(Ok(Bytes::from_static(b"private remote body"))))
                    })),
                })),
                requests: Mutex::new(Vec::new()),
            });
            let state = AppState {
                http_transport: transport,
                ..Default::default()
            };
            let url = archive_index_url("private_player").unwrap();
            let error = fetch_bounded(&state, url, MAX_INDEX_BYTES, &CancellationToken::new())
                .await
                .unwrap_err();
            assert_eq!(polls.load(Ordering::SeqCst), 0);
            assert_eq!(
                serde_json::to_value(&error).unwrap(),
                serde_json::json!({
                    "tag": "backend-error", "category": category,
                    "message": format!("Remote HTTP request rejected: status {status}"),
                    "remoteHttpRejection": {"status": status, "authorizationSent": false}
                })
            );
            assert_eq!(
                error.diagnostic(),
                format!("Remote HTTP request rejected: status {status}")
            );
        }
    }

    #[tokio::test]
    async fn native_transport_is_bounded_and_never_accepts_a_renderer_origin() {
        let transport = Arc::new(MockTransport {
            response: Mutex::new(Some(response(br#"{"archives":[]}"#))),
            requests: Mutex::new(Vec::new()),
        });
        let state = AppState {
            http_transport: transport.clone(),
            ..Default::default()
        };
        let cancellation = CancellationToken::new();
        let url = archive_index_url("felix_chess").unwrap();
        let body = fetch_bounded(&state, url, MAX_INDEX_BYTES, &cancellation)
            .await
            .unwrap();
        assert_eq!(body, br#"{"archives":[]}"#);
        assert_eq!(
            transport.requests.lock().unwrap().as_slice(),
            ["https://api.chess.com/pub/player/felix_chess/games/archives"]
        );
    }

    #[test]
    fn production_runtime_dispatches_the_core_under_native_ownership() {
        let source = include_str!("chesscom.rs");
        let command = source
            .split("async fn download_chess_com_games_runtime<")
            .nth(1)
            .unwrap()
            .split("fn report_terminal_progress")
            .next()
            .unwrap();
        assert_eq!(command.matches("run_native_operation(").count(), 1);
        assert_eq!(command.matches("download_chess_com_games_core(").count(), 1);
        assert!(command.contains("ExportLimits::default()"));
    }

    #[test]
    fn download_chess_com_games_runtime_publishes_on_windows() {
        let source = include_str!("chesscom.rs");
        let body = body_at_indent(
            source,
            "pub(crate) async fn download_chess_com_games_runtime<R: tauri::Runtime>(",
        );
        assert!(!body.contains("off_unix_refusal("), "{body}");
        assert_eq!(body.matches("run_native_operation(").count(), 1, "{body}");
        assert_eq!(
            body.matches("download_chess_com_games_core(").count(),
            1,
            "{body}"
        );
    }

    #[tokio::test]
    async fn dropped_callers_retain_success_and_publication_error_terminal_tails() {
        let _reset = ResetAtomicInjector;

        let (_dir, state, destination, root, app) = export_fixture(export_transport());
        let (entered, release) = hold_atomic_point(
            crate::infra::fs::AtomicFileFaultPoint::PreCommitRevalidate,
            1,
            false,
        );
        let job_id = state.operations.prepare_download("test").unwrap();
        let task = tokio::spawn(run_owned_export(
            destination,
            "success.pgn".into(),
            job_id.clone(),
            app.handle().clone(),
            state.clone(),
            TERMINAL_HANG_GUARD,
        ));
        tokio::time::timeout(TERMINAL_HANG_GUARD, entered)
            .await
            .unwrap()
            .unwrap();
        task.abort();
        let _ = task.await;
        release.send(()).unwrap();
        wait_for_progress(&state, &job_id, ProgressState::Succeeded).await;
        wait_for_operation_drain(&state).await;
        assert_eq!(
            std::fs::read(root.join("success.pgn")).unwrap(),
            b"1. e4 e5\n"
        );

        crate::infra::fs::set_test_atomic_file_injector(None);
        let (_dir, state, destination, root, app) = export_fixture(export_transport());
        std::fs::write(root.join("failure.pgn"), b"previous").unwrap();
        let (entered, release) = hold_atomic_point(
            crate::infra::fs::AtomicFileFaultPoint::PreCommitRevalidate,
            1,
            true,
        );
        let job_id = state.operations.prepare_download("test").unwrap();
        let task = tokio::spawn(run_owned_export(
            destination,
            "failure.pgn".into(),
            job_id.clone(),
            app.handle().clone(),
            state.clone(),
            TERMINAL_HANG_GUARD,
        ));
        tokio::time::timeout(TERMINAL_HANG_GUARD, entered)
            .await
            .unwrap()
            .unwrap();
        task.abort();
        let _ = task.await;
        release.send(()).unwrap();
        wait_for_progress(&state, &job_id, ProgressState::Failed).await;
        wait_for_operation_drain(&state).await;
        assert_eq!(
            std::fs::read(root.join("failure.pgn")).unwrap(),
            b"previous"
        );
    }

    #[tokio::test]
    async fn prepublication_error_and_cancellation_are_terminal_without_replacement() {
        let bad_transport: Arc<dyn DownloadTransport> = Arc::new(ExportTransport {
            responses: Mutex::new(VecDeque::from([response(br#"{"archives":[]}"#)])),
        });
        let (_dir, state, destination, root, app) = export_fixture(bad_transport);
        std::fs::write(root.join("error.pgn"), b"previous").unwrap();
        let job_id = state.operations.prepare_download("test").unwrap();
        let error = run_owned_export(
            destination,
            "error.pgn".into(),
            job_id.clone(),
            app.handle().clone(),
            state.clone(),
            Duration::from_secs(2),
        )
        .await
        .unwrap_err();
        assert!(matches!(error, Error::InvalidInput(_)));
        assert_eq!(
            state.progress_state.get(&job_id).unwrap().unwrap().state,
            ProgressState::Failed
        );
        assert_eq!(std::fs::read(root.join("error.pgn")).unwrap(), b"previous");

        let (entered_tx, entered) = tokio::sync::oneshot::channel();
        let held = Arc::new(HeldArchiveTransport {
            requests: AtomicUsize::new(0),
            entered: Mutex::new(Some(entered_tx)),
            release: tokio::sync::Notify::new(),
        });
        let (_dir, state, destination, root, app) = export_fixture(held.clone());
        std::fs::write(root.join("cancel.pgn"), b"previous").unwrap();
        let job_id = state.operations.prepare_download("test").unwrap();
        let task = tokio::spawn(run_owned_export(
            destination,
            "cancel.pgn".into(),
            job_id.clone(),
            app.handle().clone(),
            state.clone(),
            Duration::from_secs(2),
        ));
        tokio::time::timeout(Duration::from_secs(2), entered)
            .await
            .unwrap()
            .unwrap();
        assert!(state.operations.cancel_download(&job_id, "test").unwrap());
        held.release.notify_waiters();
        assert!(matches!(task.await.unwrap(), Err(Error::Cancellation)));
        assert_eq!(
            state.progress_state.get(&job_id).unwrap().unwrap().state,
            ProgressState::Cancelled
        );
        assert_eq!(std::fs::read(root.join("cancel.pgn")).unwrap(), b"previous");
    }

    #[tokio::test]
    async fn cancellation_after_final_archive_fetch_stops_before_staging() {
        struct ResetStagedPgnCapture;

        impl Drop for ResetStagedPgnCapture {
            fn drop(&mut self) {
                *STAGED_PGN_CAPTURE.lock().unwrap() = None;
            }
        }

        struct CancelOnDropArchiveStream {
            body: Option<Bytes>,
            state: AppState,
            job_id: String,
        }

        impl futures_util::Stream for CancelOnDropArchiveStream {
            type Item = Result<Bytes, Error>;

            fn poll_next(
                self: std::pin::Pin<&mut Self>,
                _: &mut std::task::Context<'_>,
            ) -> std::task::Poll<Option<Self::Item>> {
                std::task::Poll::Ready(self.get_mut().body.take().map(Ok))
            }
        }

        impl Drop for CancelOnDropArchiveStream {
            fn drop(&mut self) {
                assert!(self
                    .state
                    .operations
                    .cancel_download(&self.job_id, "test")
                    .unwrap());
            }
        }

        struct CancelAfterArchiveTransport {
            requests: AtomicUsize,
            archive: Mutex<Option<DownloadResponse>>,
        }

        #[async_trait]
        impl DownloadTransport for CancelAfterArchiveTransport {
            async fn request(
                &self,
                url: &str,
                headers: HeaderMap,
            ) -> Result<DownloadResponse, Error> {
                assert!(headers.is_empty());
                if self.requests.fetch_add(1, Ordering::SeqCst) == 0 {
                    return Ok(response(INDEX));
                }
                assert_eq!(url, "https://api.chess.com/pub/player/felix/games/2026/09");
                self.archive
                    .lock()
                    .unwrap()
                    .take()
                    .ok_or_else(|| Error::InvalidInput("unexpected request".into()))
            }
        }

        let transport = Arc::new(CancelAfterArchiveTransport {
            requests: AtomicUsize::new(0),
            archive: Mutex::new(None),
        });
        let (_dir, state, destination, root, app) = export_fixture(transport.clone());
        std::fs::write(root.join("cancel.pgn"), b"previous").unwrap();
        let job_id = state.operations.prepare_download("test").unwrap();
        let body = br#"{"games":[{"pgn":"1. e4 e5 {CANCEL-STAGING-MARKER-f20260920-02}"},{"pgn":"1. d4 d5 {CANCEL-STAGING-MARKER-f20260920-02}"}]}"#;
        *transport.archive.lock().unwrap() = Some(DownloadResponse {
            status: 200,
            headers: HeaderMap::new(),
            content_length: Some(body.len() as u64),
            stream: Box::pin(CancelOnDropArchiveStream {
                body: Some(Bytes::from_static(body)),
                state: state.clone(),
                job_id: job_id.clone(),
            }),
        });
        let captured = Arc::new(Mutex::new(Vec::new()));
        {
            let mut slot = STAGED_PGN_CAPTURE.lock().unwrap();
            assert!(slot.is_none(), "staged PGN capture is already installed");
            *slot = Some(captured.clone());
        }
        let _reset_capture = ResetStagedPgnCapture;
        let task = tokio::spawn(run_owned_export(
            destination,
            "cancel.pgn".into(),
            job_id.clone(),
            app.handle().clone(),
            state.clone(),
            Duration::from_secs(2),
        ));
        assert!(matches!(task.await.unwrap(), Err(Error::Cancellation)));
        assert_eq!(transport.requests.load(Ordering::SeqCst), 2);
        wait_for_progress(&state, &job_id, ProgressState::Cancelled).await;
        assert_eq!(std::fs::read(root.join("cancel.pgn")).unwrap(), b"previous");
        wait_for_operation_drain(&state).await;
        let marker = b"CANCEL-STAGING-MARKER-f20260920-02";
        assert!(!captured
            .lock()
            .unwrap()
            .windows(marker.len())
            .any(|bytes| bytes == marker));
    }

    #[tokio::test]
    async fn staging_deadline_fails_terminally_without_publication() {
        let (entered_tx, entered) = tokio::sync::oneshot::channel();
        let held = Arc::new(HeldArchiveTransport {
            requests: AtomicUsize::new(0),
            entered: Mutex::new(Some(entered_tx)),
            release: tokio::sync::Notify::new(),
        });
        let (_dir, state, destination, root, app) = export_fixture(held.clone());
        std::fs::write(root.join("deadline.pgn"), b"previous").unwrap();
        let job_id = state.operations.prepare_download("test").unwrap();
        let task = tokio::spawn(run_owned_export(
            destination,
            "deadline.pgn".into(),
            job_id.clone(),
            app.handle().clone(),
            state.clone(),
            Duration::from_millis(500),
        ));
        tokio::time::timeout(Duration::from_secs(2), entered)
            .await
            .unwrap()
            .unwrap();
        let error = tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .unwrap()
            .unwrap()
            .unwrap_err();
        held.release.notify_waiters();
        assert!(matches!(error, Error::EngineTimeout(_)));
        assert_eq!(
            state.progress_state.get(&job_id).unwrap().unwrap().state,
            ProgressState::Failed
        );
        assert_eq!(
            std::fs::read(root.join("deadline.pgn")).unwrap(),
            b"previous"
        );
    }

    #[tokio::test]
    async fn publication_ignores_expired_staging_deadline_and_late_cancellation() {
        let _reset = ResetAtomicInjector;
        let (_dir, state, destination, root, app) = export_fixture(export_transport());
        let (entered, release) =
            hold_atomic_point(crate::infra::fs::AtomicFileFaultPoint::ParentSync, 1, false);
        let job_id = state.operations.prepare_download("test").unwrap();
        let task = tokio::spawn(run_owned_export(
            destination,
            "late.pgn".into(),
            job_id.clone(),
            app.handle().clone(),
            state.clone(),
            Duration::from_millis(500),
        ));
        tokio::time::timeout(Duration::from_secs(5), entered)
            .await
            .unwrap()
            .unwrap();
        tokio::time::sleep(Duration::from_millis(600)).await;
        assert!(!state.operations.cancel_download(&job_id, "test").unwrap());
        release.send(()).unwrap();
        let artifact = task.await.unwrap().unwrap();
        assert!(artifact.receipt_error.is_none());
        let artifact = artifact.publication;
        assert_eq!(std::fs::read(root.join("late.pgn")).unwrap(), b"1. e4 e5\n");
        assert!(state
            .pgn_path_authority
            .raw_for_test()
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .has_persistent_id(&artifact.handle.id.id));
        assert_eq!(
            state.progress_state.get(&job_id).unwrap().unwrap().state,
            ProgressState::Succeeded
        );
    }

    #[tokio::test]
    async fn cleared_terminal_progress_cannot_replace_committed_success() {
        let _reset = ResetAtomicInjector;
        let (_dir, state, destination, root, app) = export_fixture(export_transport());
        let (entered, release) =
            hold_atomic_point(crate::infra::fs::AtomicFileFaultPoint::ParentSync, 1, false);
        let job_id = state.operations.prepare_download("test").unwrap();
        let task = tokio::spawn(run_owned_export(
            destination,
            "cleared.pgn".into(),
            job_id.clone(),
            app.handle().clone(),
            state.clone(),
            TERMINAL_HANG_GUARD,
        ));
        tokio::time::timeout(TERMINAL_HANG_GUARD, entered)
            .await
            .unwrap()
            .unwrap();
        state.progress_state.clear(&job_id).unwrap();
        release.send(()).unwrap();
        let artifact = task.await.unwrap().unwrap();
        assert!(artifact.receipt_error.is_none());
        let artifact = artifact.publication;
        assert_eq!(
            std::fs::read(root.join("cleared.pgn")).unwrap(),
            b"1. e4 e5\n"
        );
        assert!(state
            .pgn_path_authority
            .raw_for_test()
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .has_persistent_id(&artifact.handle.id.id));
    }
}
