//! Native Lichess API boundary.
//!
//! The renderer may hold an opaque account handle and public response data, but never a bearer
//! token.  This module maps that handle to the OS-backed credential store and constrains every
//! authenticated request to a fixed Lichess endpoint.

use crate::{credentials::LichessAccountHandle, error::Error, AppState};
use reqwest::Url;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::time::Duration;

const ACCOUNT_URL: &str = "https://lichess.org/api/account";
const EXPLORER_URL: &str = "https://explorer.lichess.org";
const MAX_JSON_BYTES: usize = 5 * 1024 * 1024;
/// Return current player results before the JSON client's `JSON_REQUEST_TIMEOUT`, even if Lichess
/// is still streaming indexing updates.
const PLAYER_EXPLORER_DEADLINE: Duration = Duration::from_secs(20);
const _: () = assert!(
    PLAYER_EXPLORER_DEADLINE.as_millis() < crate::infra::net::JSON_REQUEST_TIMEOUT.as_millis()
);
const MAX_EXPLORER_QUERY_BYTES: usize = 8 * 1024;
const MAX_EXPLORER_QUERY_PAIRS: usize = 64;
const MIN_LICHESS_USERNAME_BYTES: usize = 2;
const MAX_LICHESS_USERNAME_BYTES: usize = 30;
pub(crate) const ACCOUNT_EXPORT_PERFS: &[&str] = &[
    "ultraBullet",
    "bullet",
    "blitz",
    "rapid",
    "classical",
    "correspondence",
];
pub(crate) const MAX_COVERAGE_HOLDS: usize = 1_000_000;
const MAX_COVERAGE_LINE_BYTES: usize = 64 * 1024;

struct NdjsonLines {
    line: Vec<u8>,
    max: usize,
    too_large: &'static str,
}

impl NdjsonLines {
    fn new(max: usize, too_large: &'static str) -> Self {
        Self {
            line: Vec::new(),
            max,
            too_large,
        }
    }

    fn push(
        &mut self,
        chunk: &[u8],
        mut on_line: impl FnMut(&[u8]) -> Result<(), Error>,
    ) -> Result<(), Error> {
        for part in chunk.split_inclusive(|byte| *byte == b'\n') {
            if self.line.len().saturating_add(part.len()) > self.max {
                return Err(Error::ResourceLimit(self.too_large.into()));
            }
            self.line.extend_from_slice(part);
            if part.last() == Some(&b'\n') {
                on_line(&self.line)?;
                self.line.clear();
            }
        }
        Ok(())
    }

    fn finish(self, mut on_line: impl FnMut(&[u8]) -> Result<(), Error>) -> Result<(), Error> {
        on_line(&self.line)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CoverageHold {
    pub(crate) id: String,
    pub(crate) created_at_ms: i64,
    pub(crate) ongoing: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CoverageGame {
    id: String,
    rated: bool,
    perf: String,
    status: String,
    created_at: i64,
}

fn coverage_line(line: &[u8], holds: &mut Vec<CoverageHold>) -> Result<(), Error> {
    if line.iter().all(u8::is_ascii_whitespace) {
        return Ok(());
    }
    let game: CoverageGame = serde_json::from_slice(line)
        .map_err(|_| Error::InvalidInput("Lichess returned invalid coverage data".into()))?;
    if game.id.len() != 8
        || !game.id.bytes().all(|byte| byte.is_ascii_alphanumeric())
        || game.created_at <= 0
    {
        return Err(Error::InvalidInput(
            "Lichess returned invalid coverage data".into(),
        ));
    }
    if game.rated
        && ACCOUNT_EXPORT_PERFS.contains(&game.perf.as_str())
        && !matches!(game.status.as_str(), "aborted" | "noStart")
    {
        if holds.len() >= MAX_COVERAGE_HOLDS {
            return Err(Error::ResourceLimit(
                "Lichess coverage has too many holds".into(),
            ));
        }
        holds.push(CoverageHold {
            id: game.id,
            created_at_ms: game.created_at,
            ongoing: matches!(game.status.as_str(), "created" | "started"),
        });
    }
    Ok(())
}

pub(crate) async fn download_coverage_holds(
    url: Url,
    token: &str,
    transport: &dyn crate::infra::net::DownloadTransport,
    cancellation: &tokio_util::sync::CancellationToken,
) -> Result<Vec<CoverageHold>, Error> {
    use futures_util::StreamExt;
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert(
        reqwest::header::ACCEPT,
        reqwest::header::HeaderValue::from_static("application/x-ndjson"),
    );
    let mut response =
        crate::fs::request_download_response(url, headers, transport, Some(token), cancellation)
            .await?;
    let mut holds = Vec::new();
    let mut lines = NdjsonLines::new(
        MAX_COVERAGE_LINE_BYTES,
        "Lichess coverage line is too large",
    );
    let mut received = 0u64;
    loop {
        let item = tokio::select! {
            _ = cancellation.cancelled() => return Err(Error::Cancellation),
            item = response.stream.next() => item,
        };
        let Some(chunk) = item else { break };
        let chunk = chunk?;
        received = received.saturating_add(chunk.len() as u64);
        lines.push(&chunk, |line| coverage_line(line, &mut holds))?;
    }
    if response
        .content_length
        .is_some_and(|length| length != received)
    {
        return Err(Error::InvalidInput(
            "Actual downloaded size mismatch".into(),
        ));
    }
    lines.finish(|line| coverage_line(line, &mut holds))?;
    Ok(holds)
}

#[derive(Clone, Debug, Deserialize, Serialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PublicLichessRequest {
    Account { username: String },
    CloudEval { fen: String, multi_pv: u8 },
    Game { game_id: String },
    Tablebase { fen: String },
    Fide { query: String },
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum LichessExplorerEndpoint {
    Lichess,
    Masters,
    Player,
}

impl LichessExplorerEndpoint {
    fn path(self) -> &'static str {
        match self {
            Self::Lichess => "/lichess",
            Self::Masters => "/masters",
            Self::Player => "/player",
        }
    }

    /// Lichess streams `/player` as NDJSON snapshots while it indexes; the others are one object.
    fn body_mode(self) -> AuthenticatedBodyMode {
        match self {
            Self::Player => AuthenticatedBodyMode::PlayerExplorer,
            Self::Lichess | Self::Masters => AuthenticatedBodyMode::SingleObject,
        }
    }
}

fn exact_url(base: &str, path: &str, query: Option<&str>) -> Result<Url, Error> {
    let intended =
        Url::parse(base).map_err(|_| Error::InvalidInput("invalid Lichess endpoint".into()))?;
    let mut url = intended.clone();
    url.set_path(path);
    url.set_query(query.filter(|query| !query.is_empty()));
    if url.scheme() != "https"
        || url.username() != ""
        || url.password().is_some()
        || url.fragment().is_some()
        || url.host_str() != intended.host_str()
        || url.port_or_known_default() != intended.port_or_known_default()
    {
        return Err(Error::InvalidInput("invalid Lichess endpoint".into()));
    }
    Ok(url)
}

pub(crate) fn lichess_user_segment(username: &str) -> Result<&str, Error> {
    let username = username.trim();
    if !(MIN_LICHESS_USERNAME_BYTES..=MAX_LICHESS_USERNAME_BYTES).contains(&username.len())
        || !username
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        return Err(Error::InvalidInput("invalid Lichess username".into()));
    }
    Ok(username)
}

#[derive(Debug, PartialEq, Eq)]
enum AuthenticatedBodyMode {
    SingleObject,
    PlayerExplorer,
}

fn json_object(body: &[u8]) -> Result<String, Error> {
    let value: serde_json::Value = serde_json::from_slice(body)
        .map_err(|_| Error::InvalidInput("Lichess returned invalid JSON".into()))?;
    if !value.is_object() {
        return Err(Error::InvalidInput(
            "Lichess returned an invalid response".into(),
        ));
    }
    String::from_utf8(body.to_vec())
        .map_err(|_| Error::InvalidInput("Lichess returned invalid UTF-8".into()))
}

fn player_snapshot_line(line: &[u8], latest: &mut Option<String>) -> Result<(), Error> {
    if !line.iter().all(u8::is_ascii_whitespace) {
        *latest = Some(json_object(line.strip_suffix(b"\n").unwrap_or(line))?);
    }
    Ok(())
}

async fn player_explorer_snapshot(
    mut stream: impl futures_util::Stream<Item = Result<bytes::Bytes, Error>> + Unpin,
    deadline: tokio::time::Instant,
) -> Result<String, Error> {
    use futures_util::StreamExt;

    let mut lines = NdjsonLines::new(MAX_JSON_BYTES, "Lichess response is too large");
    let mut latest = None;
    loop {
        let item = tokio::select! {
            biased;
            _ = tokio::time::sleep_until(deadline), if latest.is_some() => {
                return latest.ok_or_else(|| {
                    Error::InvalidInput("Lichess returned an invalid response".into())
                });
            }
            item = stream.next() => item,
        };
        let Some(chunk) = item else { break };
        lines.push(&chunk?, |line| player_snapshot_line(line, &mut latest))?;
    }
    lines.finish(|line| player_snapshot_line(line, &mut latest))?;
    latest.ok_or_else(|| Error::InvalidInput("Lichess returned an invalid response".into()))
}

async fn authenticated_json(
    handle: &LichessAccountHandle,
    state: &AppState,
    client: &reqwest::Client,
    url: Url,
    mode: AuthenticatedBodyMode,
) -> Result<String, Error> {
    let token = state
        .credentials
        .token_async(handle.clone())
        .await?
        .ok_or_else(|| Error::InvalidInput("Lichess account is unavailable".into()))?;
    let deadline = tokio::time::Instant::now() + PLAYER_EXPLORER_DEADLINE;
    let response = client
        .get(url)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|_| Error::OAuthFailure("Lichess request failed".into()))?;
    authenticated_body(response, mode, deadline).await
}

async fn authenticated_body(
    response: reqwest::Response,
    mode: AuthenticatedBodyMode,
    deadline: tokio::time::Instant,
) -> Result<String, Error> {
    if !response.status().is_success() {
        return Err(Error::OAuthFailure("Lichess request was rejected".into()));
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_JSON_BYTES as u64)
    {
        return Err(Error::ResourceLimit("Lichess response is too large".into()));
    }
    if matches!(mode, AuthenticatedBodyMode::PlayerExplorer) {
        use futures_util::StreamExt;

        let stream = response
            .bytes_stream()
            .map(|chunk| chunk.map_err(|_| Error::OAuthFailure("Lichess request failed".into())));
        return player_explorer_snapshot(stream, deadline).await;
    }
    let body = response
        .bytes()
        .await
        .map_err(|_| Error::OAuthFailure("Lichess request failed".into()))?;
    if body.len() > MAX_JSON_BYTES {
        return Err(Error::ResourceLimit("Lichess response is too large".into()));
    }
    json_object(&body)
}

async fn public_json(
    client: &reqwest::Client,
    url: Url,
    require_json: bool,
) -> Result<String, Error> {
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|_| Error::InvalidInput("Lichess request failed".into()))?;
    if !response.status().is_success() {
        return Err(Error::InvalidInput("Lichess request was rejected".into()));
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_JSON_BYTES as u64)
    {
        return Err(Error::ResourceLimit("Lichess response is too large".into()));
    }
    let body = response
        .bytes()
        .await
        .map_err(|_| Error::InvalidInput("Lichess request failed".into()))?;
    if body.len() > MAX_JSON_BYTES {
        return Err(Error::ResourceLimit("Lichess response is too large".into()));
    }
    if require_json {
        serde_json::from_slice::<serde_json::Value>(&body)
            .map_err(|_| Error::InvalidInput("Lichess returned invalid JSON".into()))?;
    }
    String::from_utf8(body.to_vec())
        .map_err(|_| Error::InvalidInput("Lichess returned invalid UTF-8".into()))
}

fn encode_query_pair(key: &str, value: &str) -> String {
    let mut serializer = url::form_urlencoded::Serializer::new(String::new());
    serializer.append_pair(key, value);
    serializer.finish()
}

#[tauri::command]
#[specta::specta]
pub async fn get_public_lichess_json(
    request: PublicLichessRequest,
    state: tauri::State<'_, AppState>,
) -> Result<String, Error> {
    let (url, require_json) = public_lichess_url(request)?;
    public_json(&state.json_http_client, url, require_json).await
}

fn public_lichess_url(request: PublicLichessRequest) -> Result<(Url, bool), Error> {
    let is_game = matches!(request, PublicLichessRequest::Game { .. });
    let url = match request {
        PublicLichessRequest::Account { username } => {
            let username = lichess_user_segment(&username)?;
            exact_url(
                "https://lichess.org",
                &format!("/api/user/{username}"),
                None,
            )?
        }
        PublicLichessRequest::CloudEval { fen, multi_pv } => {
            if fen.is_empty() || fen.len() > 512 || multi_pv == 0 || multi_pv > 10 {
                return Err(Error::InvalidInput("invalid Lichess cloud request".into()));
            }
            exact_url(
                "https://lichess.org",
                "/api/cloud-eval",
                Some(format!(
                    "{}&multiPv={multi_pv}",
                    encode_query_pair("fen", &fen)
                ))
                .as_deref(),
            )?
        }
        PublicLichessRequest::Game { game_id } => {
            let id = game_id.chars().take(8).collect::<String>();
            if id.len() != 8 || !id.bytes().all(|byte| byte.is_ascii_alphanumeric()) {
                return Err(Error::InvalidInput("invalid Lichess game ID".into()));
            }
            exact_url("https://lichess.org", &format!("/game/export/{id}"), None)?
        }
        PublicLichessRequest::Tablebase { fen } => {
            if fen.is_empty() || fen.len() > 512 {
                return Err(Error::InvalidInput("invalid tablebase FEN".into()));
            }
            exact_url(
                "https://tablebase.lichess.org",
                "/standard",
                Some(encode_query_pair("fen", &fen)).as_deref(),
            )?
        }
        PublicLichessRequest::Fide { query } => {
            if query.is_empty() || query.len() > 100 {
                return Err(Error::InvalidInput("invalid FIDE query".into()));
            }
            if query.bytes().all(|byte| byte.is_ascii_digit()) {
                exact_url(
                    "https://lichess.org",
                    &format!("/api/fide/player/{query}"),
                    None,
                )?
            } else {
                exact_url(
                    "https://lichess.org",
                    "/api/fide/player",
                    Some(encode_query_pair("q", &query)).as_deref(),
                )?
            }
        }
    };
    Ok((url, !is_game))
}

fn normalized_explorer_query(query: &str) -> Result<String, Error> {
    if query.len() > MAX_EXPLORER_QUERY_BYTES {
        return Err(Error::ResourceLimit(
            "Lichess explorer query is too large".into(),
        ));
    }
    let pairs: Vec<_> = url::form_urlencoded::parse(query.as_bytes()).collect();
    if pairs.len() > MAX_EXPLORER_QUERY_PAIRS {
        return Err(Error::ResourceLimit(
            "Lichess explorer query has too many parameters".into(),
        ));
    }
    let mut serializer = url::form_urlencoded::Serializer::new(String::new());
    for (key, value) in pairs {
        serializer.append_pair(&key, &value);
    }
    Ok(serializer.finish())
}

#[tauri::command]
#[specta::specta]
pub async fn get_authenticated_lichess_account(
    handle: LichessAccountHandle,
    state: tauri::State<'_, AppState>,
) -> Result<String, Error> {
    let url = exact_url(ACCOUNT_URL, "/api/account", None)?;
    let body = authenticated_json(
        &handle,
        &state,
        &state.json_http_client,
        url,
        AuthenticatedBodyMode::SingleObject,
    )
    .await?;
    let value: serde_json::Value = serde_json::from_str(&body)
        .map_err(|_| Error::InvalidInput("Lichess returned invalid JSON".into()))?;
    if value
        .get("id")
        .and_then(serde_json::Value::as_str)
        .filter(|id| !id.is_empty())
        .is_none()
        || value
            .get("username")
            .and_then(serde_json::Value::as_str)
            .filter(|username| !username.is_empty())
            .is_none()
    {
        return Err(Error::InvalidInput(
            "Lichess returned an invalid account".into(),
        ));
    }
    let actual_username = value
        .get("username")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| Error::InvalidInput("Lichess returned an invalid account".into()))?;
    let expected_username = state
        .credentials
        .list()?
        .into_iter()
        .find(|account| account.handle == handle)
        .map(|account| account.username)
        .ok_or_else(|| Error::InvalidInput("Lichess account is unavailable".into()))?;
    if !expected_username.eq_ignore_ascii_case(actual_username) {
        return Err(Error::OAuthFailure(
            "Lichess account identity changed".into(),
        ));
    }
    Ok(body)
}

#[tauri::command]
#[specta::specta]
pub async fn get_authenticated_lichess_explorer(
    handle: LichessAccountHandle,
    endpoint: LichessExplorerEndpoint,
    query: String,
    state: tauri::State<'_, AppState>,
) -> Result<String, Error> {
    // Parsing first rejects malformed percent escapes; URL then serializes the query without
    // accepting a renderer-provided host/path/fragment.
    let encoded = normalized_explorer_query(&query)?;
    let url = exact_url(EXPLORER_URL, endpoint.path(), Some(&encoded))?;
    authenticated_json(
        &handle,
        &state,
        &state.json_http_client,
        url,
        endpoint.body_mode(),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::{stream, StreamExt};

    #[test]
    fn only_the_player_explorer_reads_ndjson_snapshots() {
        assert_eq!(
            LichessExplorerEndpoint::Player.body_mode(),
            AuthenticatedBodyMode::PlayerExplorer
        );
        for endpoint in [
            LichessExplorerEndpoint::Lichess,
            LichessExplorerEndpoint::Masters,
        ] {
            assert_eq!(endpoint.body_mode(), AuthenticatedBodyMode::SingleObject);
        }
    }

    #[tokio::test]
    async fn authenticated_player_body_returns_latest_snapshot(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let response = reqwest::Response::from(
            tauri::http::Response::builder()
                .status(200)
                .body("{\"white\":1}\n\n{\"white\":2}\n")?,
        );
        let snapshot = authenticated_body(
            response,
            AuthenticatedBodyMode::PlayerExplorer,
            tokio::time::Instant::now() + PLAYER_EXPLORER_DEADLINE,
        )
        .await?;
        assert_eq!(snapshot, r#"{"white":2}"#);
        Ok(())
    }

    #[tokio::test]
    async fn authenticated_single_object_body_rejects_ndjson(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let response = reqwest::Response::from(
            tauri::http::Response::builder()
                .status(200)
                .body("{\"white\":1}\n\n{\"white\":2}\n")?,
        );
        let result = authenticated_body(
            response,
            AuthenticatedBodyMode::SingleObject,
            tokio::time::Instant::now() + PLAYER_EXPLORER_DEADLINE,
        )
        .await;
        assert!(matches!(
            result,
            Err(Error::InvalidInput(message)) if message == "Lichess returned invalid JSON"
        ));
        Ok(())
    }

    #[tokio::test]
    async fn authenticated_body_rejects_unsuccessful_status_in_both_modes(
    ) -> Result<(), Box<dyn std::error::Error>> {
        for mode in [
            AuthenticatedBodyMode::PlayerExplorer,
            AuthenticatedBodyMode::SingleObject,
        ] {
            let response = reqwest::Response::from(
                tauri::http::Response::builder()
                    .status(401)
                    .body("{\"white\":1}\n\n{\"white\":2}\n")?,
            );
            let result = authenticated_body(
                response,
                mode,
                tokio::time::Instant::now() + PLAYER_EXPLORER_DEADLINE,
            )
            .await;
            assert!(matches!(
                result,
                Err(Error::OAuthFailure(message)) if message == "Lichess request was rejected"
            ));
        }
        Ok(())
    }

    #[tokio::test]
    async fn player_keeps_latest_snapshot_across_chunks_and_blank_keep_alive() -> Result<(), Error>
    {
        let chunks: &[&[u8]] = &[
            b"{\"white\":",
            b"1}\n \t\r\n{ \"white\": 2, ",
            b"\"moves\": [] }\n",
        ];
        let stream = stream::iter(
            chunks
                .iter()
                .map(|chunk| Ok(bytes::Bytes::copy_from_slice(chunk))),
        );
        let snapshot = player_explorer_snapshot(
            stream,
            tokio::time::Instant::now() + PLAYER_EXPLORER_DEADLINE,
        )
        .await?;
        assert_eq!(snapshot, r#"{ "white": 2, "moves": [] }"#);
        Ok(())
    }

    #[tokio::test]
    async fn player_returns_unterminated_final_snapshot() -> Result<(), Error> {
        let stream = stream::iter([
            Ok(bytes::Bytes::from_static(b"{\"white\":1}\n")),
            Ok(bytes::Bytes::from_static(b"{\"white\":")),
            Ok(bytes::Bytes::from_static(b"2}")),
        ]);
        let snapshot = player_explorer_snapshot(
            stream,
            tokio::time::Instant::now() + PLAYER_EXPLORER_DEADLINE,
        )
        .await?;
        assert_eq!(snapshot, r#"{"white":2}"#);
        Ok(())
    }

    #[tokio::test]
    async fn player_rejects_non_objects_invalid_json_and_invalid_utf8() {
        for (line, message) in [
            (b"[]\n".as_slice(), "Lichess returned an invalid response"),
            (b"null", "Lichess returned an invalid response"),
            (b"{\n", "Lichess returned invalid JSON"),
            (b"{\"name\":\"\xff\"}\n", "Lichess returned invalid JSON"),
        ] {
            let stream = stream::iter([
                Ok(bytes::Bytes::from_static(b"{}\n")),
                Ok(bytes::Bytes::from_static(line)),
            ]);
            let result = player_explorer_snapshot(
                stream,
                tokio::time::Instant::now() + PLAYER_EXPLORER_DEADLINE,
            )
            .await;
            assert!(matches!(result, Err(Error::InvalidInput(actual)) if actual == message));
        }
    }

    #[tokio::test]
    async fn player_rejects_streams_without_snapshots() {
        for body in [b"\n \t\r\n  ".as_slice(), b""] {
            let result = player_explorer_snapshot(
                stream::iter([Ok(bytes::Bytes::from_static(body))]),
                tokio::time::Instant::now() + PLAYER_EXPLORER_DEADLINE,
            )
            .await;
            assert!(matches!(
                result,
                Err(Error::InvalidInput(message)) if message == "Lichess returned an invalid response"
            ));
        }
    }

    #[tokio::test]
    async fn player_rejects_lines_over_the_bound_across_chunks() {
        let stream = stream::iter([
            Ok(bytes::Bytes::from(vec![b' '; MAX_JSON_BYTES])),
            Ok(bytes::Bytes::from_static(b"\n")),
        ]);
        let result = player_explorer_snapshot(
            stream,
            tokio::time::Instant::now() + PLAYER_EXPLORER_DEADLINE,
        )
        .await;
        assert!(matches!(
            result,
            Err(Error::ResourceLimit(message)) if message == "Lichess response is too large"
        ));
    }

    #[tokio::test]
    async fn player_propagates_stream_failure_after_a_snapshot() {
        let stream = stream::iter([
            Ok(bytes::Bytes::from_static(b"{}\n")),
            Err(Error::OAuthFailure("Lichess request failed".into())),
        ]);
        let result = player_explorer_snapshot(
            stream,
            tokio::time::Instant::now() + PLAYER_EXPLORER_DEADLINE,
        )
        .await;
        assert!(matches!(
            result,
            Err(Error::OAuthFailure(message)) if message == "Lichess request failed"
        ));
    }

    #[tokio::test(start_paused = true)]
    async fn player_returns_current_snapshot_at_deadline() -> Result<(), Error> {
        let stream = stream::iter([Ok(bytes::Bytes::from_static(b"{\"white\":1}\n"))])
            .chain(stream::pending());
        let deadline = tokio::time::Instant::now() + PLAYER_EXPLORER_DEADLINE;
        let snapshot = player_explorer_snapshot(stream, deadline).await?;
        assert_eq!(snapshot, r#"{"white":1}"#);
        assert_eq!(tokio::time::Instant::now(), deadline);
        Ok(())
    }

    #[tokio::test(start_paused = true)]
    async fn player_discards_incomplete_snapshot_at_deadline() -> Result<(), Error> {
        let stream = stream::iter([Ok(bytes::Bytes::from_static(b"{\"white\":1}\n{\"white\":"))])
            .chain(stream::pending());
        let deadline = tokio::time::Instant::now() + PLAYER_EXPLORER_DEADLINE;
        let snapshot = player_explorer_snapshot(stream, deadline).await?;
        assert_eq!(snapshot, r#"{"white":1}"#);
        assert_eq!(tokio::time::Instant::now(), deadline);
        Ok(())
    }

    #[tokio::test(start_paused = true)]
    async fn player_keeps_waiting_after_deadline_without_a_snapshot() {
        let deadline = tokio::time::Instant::now() + PLAYER_EXPLORER_DEADLINE;
        let result = tokio::time::timeout_at(
            deadline + Duration::from_millis(1),
            player_explorer_snapshot(stream::pending(), deadline),
        )
        .await;
        assert!(result.is_err());
    }

    #[tokio::test(start_paused = true)]
    async fn player_accepts_first_snapshot_after_deadline() -> Result<(), Error> {
        let deadline = tokio::time::Instant::now() + PLAYER_EXPLORER_DEADLINE;
        let stream = Box::pin(
            stream::once(async move {
                tokio::time::sleep_until(deadline + Duration::from_secs(1)).await;
                Ok(bytes::Bytes::from_static(b"{\"white\":1}\n"))
            })
            .chain(stream::pending()),
        );
        let snapshot = player_explorer_snapshot(stream, deadline).await?;
        assert_eq!(snapshot, r#"{"white":1}"#);
        assert!(tokio::time::Instant::now() > deadline);
        Ok(())
    }

    #[tokio::test]
    async fn coverage_preserves_partial_lines_across_chunks_and_parses_unterminated_final_line(
    ) -> Result<(), Box<dyn std::error::Error>> {
        struct ChunkedCoverageTransport;

        #[async_trait::async_trait]
        impl crate::infra::net::DownloadTransport for ChunkedCoverageTransport {
            async fn request(
                &self,
                _: &str,
                headers: reqwest::header::HeaderMap,
            ) -> Result<crate::infra::net::DownloadResponse, Error> {
                assert_eq!(headers[reqwest::header::ACCEPT], "application/x-ndjson");
                assert_eq!(
                    headers[reqwest::header::AUTHORIZATION],
                    "Bearer fixture-token"
                );
                let chunks: &[&[u8]] = &[
                    br#"{"id":"Corr"#,
                    br#"esp1","rated":true,"perf":"correspondence","status":"star"#,
                    b"ted\",\"createdAt\":100}\n{\"id\":\"Blit",
                    br#"z001","rated":true,"perf":"blitz","status":"mate","createdAt":"#,
                    b"200}",
                ];
                Ok(crate::infra::net::DownloadResponse {
                    status: 200,
                    headers: reqwest::header::HeaderMap::new(),
                    content_length: Some(chunks.iter().map(|chunk| chunk.len() as u64).sum()),
                    stream: Box::pin(futures_util::stream::iter(
                        chunks
                            .iter()
                            .map(|chunk| Ok(bytes::Bytes::copy_from_slice(chunk)))
                            .collect::<Vec<_>>(),
                    )),
                })
            }
        }

        let holds = download_coverage_holds(
            Url::parse("https://lichess.org/api/games/user/player")?,
            "fixture-token",
            &ChunkedCoverageTransport,
            &tokio_util::sync::CancellationToken::new(),
        )
        .await?;
        assert_eq!(
            holds,
            vec![
                CoverageHold {
                    id: "Corresp1".into(),
                    created_at_ms: 100,
                    ongoing: true,
                },
                CoverageHold {
                    id: "Blitz001".into(),
                    created_at_ms: 200,
                    ongoing: false,
                },
            ]
        );
        Ok(())
    }

    #[test]
    fn coverage_eligibility_uses_the_export_perf_set_and_status() {
        for perf in ACCOUNT_EXPORT_PERFS
            .iter()
            .copied()
            .chain(["chess960", "atomic"])
        {
            for rated in [false, true] {
                for status in [
                    "created",
                    "started",
                    "mate",
                    "outoftime",
                    "resign",
                    "aborted",
                    "noStart",
                ] {
                    let line = serde_json::json!({"id":"AbCd1234", "rated":rated, "perf":perf, "status":status, "createdAt":100, "lastMoveAt":1});
                    let mut holds = Vec::new();
                    coverage_line(line.to_string().as_bytes(), &mut holds).unwrap();
                    let eligible = rated
                        && ACCOUNT_EXPORT_PERFS.contains(&perf)
                        && !matches!(status, "aborted" | "noStart");
                    assert_eq!(holds.len(), usize::from(eligible), "{line}");
                    if eligible {
                        assert_eq!(holds[0].created_at_ms, 100);
                        assert_eq!(holds[0].ongoing, matches!(status, "created" | "started"));
                    }
                }
            }
        }
    }

    #[test]
    fn coverage_rejects_bad_lines_missing_fields_and_invalid_identity() {
        let valid = serde_json::json!({"id":"AbCd1234", "rated":true, "perf":"blitz", "status":"mate", "createdAt":100});
        for field in ["id", "rated", "perf", "status", "createdAt"] {
            let mut line = valid.clone();
            line.as_object_mut().unwrap().remove(field);
            assert!(matches!(
                coverage_line(line.to_string().as_bytes(), &mut vec![]),
                Err(Error::InvalidInput(_))
            ));
        }
        for line in [b"not-json".as_slice(), b"{", b"null", b"\xff"] {
            let error = coverage_line(line, &mut vec![]).unwrap_err();
            assert!(
                matches!(error, Error::InvalidInput(ref message) if message == "Lichess returned invalid coverage data")
            );
        }
        for (field, value) in [
            ("id", serde_json::json!("bad")),
            ("createdAt", serde_json::json!(-1)),
        ] {
            let mut line = valid.clone();
            line[field] = value;
            assert!(coverage_line(line.to_string().as_bytes(), &mut vec![]).is_err());
        }
    }

    #[test]
    fn coverage_holds_stop_at_the_named_bound() {
        let hold = CoverageHold {
            id: "AbCd1234".into(),
            created_at_ms: 100,
            ongoing: true,
        };
        let mut holds = vec![hold; MAX_COVERAGE_HOLDS - 1];
        let line =
            br#"{"id":"AbCd1234","rated":true,"perf":"blitz","status":"started","createdAt":100}"#;
        coverage_line(line, &mut holds).unwrap();
        assert_eq!(holds.len(), MAX_COVERAGE_HOLDS);
        assert!(matches!(
            coverage_line(line, &mut holds),
            Err(Error::ResourceLimit(_))
        ));
        assert_eq!(holds.len(), MAX_COVERAGE_HOLDS);
    }

    #[test]
    fn json_and_oauth_requests_reuse_the_app_state_client() {
        let state = AppState::default();
        let services = crate::oauth::ProdOAuthServices::new(state.json_http_client.clone());
        assert!(services.shares_http_client(&state.json_http_client));
    }

    #[test]
    fn endpoints_are_fixed_to_https_lichess_origins() {
        let account = exact_url(ACCOUNT_URL, "/api/account", None).unwrap();
        assert_eq!(account.as_str(), ACCOUNT_URL);
        for endpoint in [
            LichessExplorerEndpoint::Lichess,
            LichessExplorerEndpoint::Masters,
            LichessExplorerEndpoint::Player,
        ] {
            let url = exact_url(
                EXPLORER_URL,
                endpoint.path(),
                Some("fen=a%20b&player=x%26y"),
            )
            .unwrap();
            assert_eq!(url.scheme(), "https");
            assert_eq!(url.host_str(), Some("explorer.lichess.org"));
            assert_eq!(url.path(), endpoint.path());
            assert_eq!(url.query(), Some("fen=a%20b&player=x%26y"));
        }
    }

    #[test]
    fn public_account_url_preserves_one_validated_username_segment() {
        let (url, require_json) = public_lichess_url(PublicLichessRequest::Account {
            username: "  Valid_user-2  ".into(),
        })
        .unwrap();
        assert_eq!(url.as_str(), "https://lichess.org/api/user/Valid_user-2");
        assert!(require_json);
    }

    #[test]
    fn public_account_url_rejects_traversal_and_invalid_usernames() {
        for username in [
            "../account",
            "/account",
            "a/b",
            "%2e%2e",
            ".",
            "..",
            "%",
            "",
            "a",
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "üser",
        ] {
            assert!(
                public_lichess_url(PublicLichessRequest::Account {
                    username: username.into(),
                })
                .is_err(),
                "{username}"
            );
        }
    }

    #[test]
    fn public_lichess_url_covers_fixed_endpoints_and_rejects_invalid_payloads() {
        let (cloud, _) = public_lichess_url(PublicLichessRequest::CloudEval {
            fen: "8/8/8/8/8/8/8/K6k w - - 0 1".into(),
            multi_pv: 1,
        })
        .unwrap();
        assert_eq!(cloud.host_str(), Some("lichess.org"));
        assert_eq!(cloud.path(), "/api/cloud-eval");

        let (game, require_json) = public_lichess_url(PublicLichessRequest::Game {
            game_id: "abcdefgh".into(),
        })
        .unwrap();
        assert_eq!(game.path(), "/game/export/abcdefgh");
        assert!(!require_json);

        let (tablebase, _) = public_lichess_url(PublicLichessRequest::Tablebase {
            fen: "8/8/8/8/8/8/8/K6k w - - 0 1".into(),
        })
        .unwrap();
        assert_eq!(tablebase.host_str(), Some("tablebase.lichess.org"));

        let (fide_id, _) = public_lichess_url(PublicLichessRequest::Fide {
            query: "150301310".into(),
        })
        .unwrap();
        assert_eq!(fide_id.path(), "/api/fide/player/150301310");
        let (fide_name, _) = public_lichess_url(PublicLichessRequest::Fide {
            query: "Carlsen".into(),
        })
        .unwrap();
        assert_eq!(fide_name.path(), "/api/fide/player");

        assert!(public_lichess_url(PublicLichessRequest::CloudEval {
            fen: String::new(),
            multi_pv: 1,
        })
        .is_err());
        assert!(public_lichess_url(PublicLichessRequest::Game {
            game_id: "short".into(),
        })
        .is_err());
        assert!(
            public_lichess_url(PublicLichessRequest::Tablebase { fen: String::new() }).is_err()
        );
        assert!(public_lichess_url(PublicLichessRequest::Fide {
            query: String::new(),
        })
        .is_err());
    }

    #[test]
    fn exact_url_rejects_non_https_and_userinfo() {
        assert!(exact_url("http://lichess.org", "/api/account", None).is_err());
        assert!(exact_url("https://user:pass@lichess.org", "/api/account", None).is_err());
        assert!(exact_url("https://lichess.org/#frag", "/api/account", None).is_err());
    }

    #[test]
    fn exact_url_pins_tablebase_host() {
        let url = exact_url(
            "https://tablebase.lichess.org",
            "/standard",
            Some("fen=8%2F8%2F8%2F8%2F8%2F8%2F8%2FK6k"),
        )
        .unwrap();
        assert_eq!(url.scheme(), "https");
        assert_eq!(url.host_str(), Some("tablebase.lichess.org"));
        assert_eq!(url.port_or_known_default(), Some(443));
        assert_eq!(url.path(), "/standard");
    }

    #[test]
    fn explorer_query_has_byte_and_pair_limits_before_url_construction() {
        assert!(normalized_explorer_query(&"x".repeat(MAX_EXPLORER_QUERY_BYTES + 1)).is_err());
        let too_many_pairs = (0..=MAX_EXPLORER_QUERY_PAIRS)
            .map(|index| format!("k{index}=v"))
            .collect::<Vec<_>>()
            .join("&");
        assert!(normalized_explorer_query(&too_many_pairs).is_err());
    }
}
