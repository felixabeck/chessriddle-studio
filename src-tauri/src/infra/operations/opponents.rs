//! One native operation imports an opponent's online games.
//!
//! It exports every linked account with the chosen filter into anonymous temporary files,
//! creates the database for them, imports all exports in one transaction and merges the linked
//! usernames into one player. Nothing is published to a download destination, and on every
//! failure the database file the operation created is removed again.

use crate::{
    credentials::LichessAccountHandle,
    error::{Error, ErrorPayload},
    infra::{
        blocking::BLOCKING_GATEWAY,
        operations::run_native_operation,
        path_authority::{DatabaseHandle, DatabaseRootHandle},
    },
    progress::{
        begin_progress, report_running_progress, update_progress_with_state, GameCountSink,
        ProgressLease, ProgressState, RunningProgressUpdate,
    },
    AppState,
};
use serde::{Deserialize, Serialize};
use specta::Type;
use tokio_util::sync::CancellationToken;

const MAX_OPPONENT_ACCOUNTS: usize = 8;
const MAX_TITLE_BYTES: usize = 4096;
const MAX_FILENAME_BYTES: usize = 255;
const MAX_HANDLE_BYTES: usize = 256;
/// Share of the progress bar the exports take; the import takes the rest.
const EXPORT_PROGRESS_SHARE: f32 = 80.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) enum OpponentProvider {
    Lichess,
    Chesscom,
}

impl OpponentProvider {
    fn label(self) -> &'static str {
        match self {
            Self::Lichess => "Lichess",
            Self::Chesscom => "Chess.com",
        }
    }
}

/// One category covers what both sites call that pace; a site without a matching class is not
/// asked for it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) enum OpponentTimeControl {
    Bullet,
    Blitz,
    Rapid,
    Classical,
    Correspondence,
}

impl OpponentTimeControl {
    fn lichess_perfs(self) -> &'static [&'static str] {
        match self {
            Self::Bullet => &["ultraBullet", "bullet"],
            Self::Blitz => &["blitz"],
            Self::Rapid => &["rapid"],
            Self::Classical => &["classical"],
            Self::Correspondence => &["correspondence"],
        }
    }

    fn chess_com_classes(self) -> &'static [&'static str] {
        match self {
            Self::Bullet => &["bullet"],
            Self::Blitz => &["blitz"],
            Self::Rapid => &["rapid"],
            Self::Classical => &[],
            Self::Correspondence => &["daily"],
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OpponentAccount {
    pub provider: OpponentProvider,
    pub username: String,
}

impl OpponentAccount {
    fn validate(&self) -> Result<(), Error> {
        let valid = match self.provider {
            OpponentProvider::Lichess => {
                crate::lichess::lichess_user_segment(&self.username).is_ok()
            }
            OpponentProvider::Chesscom => crate::chesscom::valid_player(&self.username),
        };
        if valid {
            Ok(())
        } else {
            Err(Error::InvalidInput("invalid opponent account".into()))
        }
    }

    fn key(&self) -> (OpponentProvider, String) {
        (self.provider, self.username.to_ascii_lowercase())
    }
}

#[derive(Clone, Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OpponentImportRequest {
    pub root: DatabaseRootHandle,
    pub filename: String,
    pub title: String,
    pub accounts: Vec<OpponentAccount>,
    // Games that ended before this instant, in seconds since the Unix epoch, are left out.
    pub since_unix_seconds: Option<u32>,
    pub time_controls: Vec<OpponentTimeControl>,
    // The user's own Lichess sign-in. Without it the Lichess export is anonymous.
    pub lichess_handle: Option<LichessAccountHandle>,
}

impl OpponentImportRequest {
    fn validate(&self) -> Result<(), Error> {
        let mut seen = std::collections::HashSet::new();
        if self.accounts.is_empty()
            || self.accounts.len() > MAX_OPPONENT_ACCOUNTS
            || self.time_controls.is_empty()
            || self.filename.is_empty()
            || self.filename.len() > MAX_FILENAME_BYTES
            || self.title.len() > MAX_TITLE_BYTES
            || self
                .lichess_handle
                .as_ref()
                .is_some_and(|handle| handle.0.len() > MAX_HANDLE_BYTES)
            || !self
                .accounts
                .iter()
                .all(|account| seen.insert(account.key()))
        {
            return Err(Error::InvalidInput(
                "invalid opponent import request".into(),
            ));
        }
        self.accounts.iter().try_for_each(OpponentAccount::validate)
    }

    fn since_ms(&self) -> Option<i64> {
        self.since_unix_seconds
            .map(|seconds| i64::from(seconds) * 1000)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OpponentAccountGames {
    pub account: OpponentAccount,
    pub games: u32,
}

#[derive(Clone, Debug, Serialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum OpponentImportOutcome {
    // `database` is absent when no game matched: the operation then leaves no file behind.
    // `merged` is false when linked usernames met each other and stayed separate players.
    #[serde(rename_all = "camelCase")]
    Imported {
        database: Option<DatabaseHandle>,
        accounts: Vec<OpponentAccountGames>,
        merged: bool,
    },
    // The export of this account failed; `error` is that failure as any command reports it.
    #[serde(rename_all = "camelCase")]
    AccountFailed {
        account: OpponentAccount,
        error: ErrorPayload,
    },
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn import_opponent_games(
    request: OpponentImportRequest,
    ticket: String,
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> Result<OpponentImportOutcome, Error> {
    import_opponent_games_runtime(request, ticket, window.label(), app, state.inner().clone()).await
}

pub(crate) async fn import_opponent_games_runtime<R: tauri::Runtime>(
    request: OpponentImportRequest,
    ticket: String,
    owner: &str,
    app: tauri::AppHandle<R>,
    state: AppState,
) -> Result<OpponentImportOutcome, Error> {
    request.validate()?;
    crate::wait_for_reserved_migration(
        &state,
        crate::infra::path_authority::FolderSwitchKind::Database,
        Some(&ticket),
        owner,
        crate::infra::operations::ReservationKind::Download,
    )
    .await?;
    let admission_key = format!("opponent_{}", request.filename.to_lowercase());
    let lease = state.operations.claim_download(
        &ticket,
        owner,
        "import_opponent_games",
        &ticket,
        &admission_key,
        true,
        crate::fs::MAX_ACTIVE_DOWNLOADS,
    )?;
    let cancellation = lease.token();
    run_native_operation(lease, "import_opponent_games", async move {
        if cancellation.is_cancelled() {
            return Err(Error::Cancellation);
        }
        let progress = begin_progress(&state.progress_state, &app, ticket.clone())?;
        let result = import_core(request, &ticket, &app, &state, &progress, &cancellation).await;
        let terminal = match &result {
            Ok(OpponentImportOutcome::Imported { .. }) => ProgressState::Succeeded,
            Ok(OpponentImportOutcome::AccountFailed { .. }) => ProgressState::Failed,
            Err(Error::Cancellation) => ProgressState::Cancelled,
            Err(_) => ProgressState::Failed,
        };
        let value = if matches!(terminal, ProgressState::Succeeded) {
            100.0
        } else {
            0.0
        };
        if let Err(error) =
            update_progress_with_state(&state.progress_state, &app, &progress, value, terminal)
        {
            log::warn!(
                "opponent import terminal progress failed: {}",
                error.category()
            );
        }
        result
    })
    .await
}

/// A failure of the export itself is the account's: the site refused or could not be reached,
/// the sign-in was unusable, or the site's answer was not usable. Everything else (local I/O,
/// the database) belongs to the operation.
fn is_account_failure(error: &Error) -> bool {
    matches!(
        error,
        Error::RemoteHttpRejection(_)
            | Error::Reqwest(_)
            | Error::NetworkTimeout(_)
            | Error::OAuthFailure(_)
            | Error::InvalidInput(_)
            | Error::ResourceLimit(_)
    )
}

async fn import_core<R: tauri::Runtime>(
    request: OpponentImportRequest,
    ticket: &str,
    app: &tauri::AppHandle<R>,
    state: &AppState,
    progress: &ProgressLease,
    cancellation: &CancellationToken,
) -> Result<OpponentImportOutcome, Error> {
    let since_ms = request.since_ms();
    let total = request.accounts.len();
    let mut staged = Vec::new();
    let mut loaded_games: Option<u32> = None;
    let progress_error_diagnosed = std::sync::atomic::AtomicBool::new(false);
    for (index, account) in request.accounts.iter().enumerate() {
        if cancellation.is_cancelled() {
            return Err(Error::Cancellation);
        }
        let mut on_count = |count| {
            report_running_progress(
                &state.progress_state,
                app,
                progress,
                RunningProgressUpdate {
                    progress: 0.0,
                    count: Some(count),
                },
                "opponent import",
                &progress_error_diagnosed,
                cancellation,
            )
        };
        let exported = export_account(
            state,
            account,
            since_ms,
            &request.time_controls,
            request.lichess_handle.as_ref(),
            cancellation,
            GameCountSink {
                initial_count: loaded_games,
                on_count: &mut on_count,
            },
        )
        .await;
        match exported {
            Ok(Some((file, games))) => {
                loaded_games = Some(loaded_games.unwrap_or(0).saturating_add(games));
                staged.push((index, file));
            }
            Ok(None) => {}
            Err(error) if is_account_failure(&error) => {
                log::warn!(
                    "opponent export failed for a {} account: {}",
                    account.provider.label(),
                    error.diagnostic()
                );
                return Ok(OpponentImportOutcome::AccountFailed {
                    account: account.clone(),
                    error: error.renderer_payload(),
                });
            }
            Err(error) => return Err(error),
        }
        report_running_progress(
            &state.progress_state,
            app,
            progress,
            RunningProgressUpdate {
                progress: ((index + 1) as f32 / total as f32) * EXPORT_PROGRESS_SHARE,
                count: None,
            },
            "opponent import",
            &progress_error_diagnosed,
            cancellation,
        )?;
    }

    let native = state.clone();
    let conversion_app = app.clone();
    let progress_id = format!("conversion:{ticket}");
    BLOCKING_GATEWAY
        .spawn_cancellable(cancellation.clone(), move |token| {
            import_staged_blocking(&native, request, staged, conversion_app, progress_id, token)
        })
        .await
}

/// `Ok(None)` means this site has nothing to ask for under the chosen time controls.
async fn export_account(
    state: &AppState,
    account: &OpponentAccount,
    since_ms: Option<i64>,
    time_controls: &[OpponentTimeControl],
    lichess_handle: Option<&LichessAccountHandle>,
    cancellation: &CancellationToken,
    count: GameCountSink<'_>,
) -> Result<Option<(std::fs::File, u32)>, Error> {
    match account.provider {
        OpponentProvider::Lichess => {
            let perfs: Vec<&'static str> = crate::lichess::ACCOUNT_EXPORT_PERFS
                .iter()
                .copied()
                .filter(|perf| {
                    time_controls
                        .iter()
                        .any(|control| control.lichess_perfs().contains(perf))
                })
                .collect();
            if perfs.is_empty() {
                return Ok(None);
            }
            let token = state
                .credentials
                .optional_lichess_token_async(lichess_handle.cloned())
                .await?;
            crate::fs::export_lichess_games_to_file(
                state,
                &account.username,
                since_ms,
                &perfs,
                token.as_deref(),
                cancellation,
                count,
            )
            .await
            .map(Some)
        }
        OpponentProvider::Chesscom => {
            let time_classes: Vec<&'static str> = time_controls
                .iter()
                .flat_map(|control| control.chess_com_classes().iter().copied())
                .collect();
            if time_classes.is_empty() {
                return Ok(None);
            }
            crate::chesscom::export_filtered_games_to_file(
                state,
                &account.username,
                since_ms,
                time_classes,
                cancellation,
                count,
            )
            .await
            .map(Some)
        }
    }
}

fn import_staged_blocking<R: tauri::Runtime>(
    state: &AppState,
    request: OpponentImportRequest,
    staged: Vec<(usize, std::fs::File)>,
    app: tauri::AppHandle<R>,
    progress_id: String,
    cancellation: &CancellationToken,
) -> Result<OpponentImportOutcome, Error> {
    use std::io::Seek;

    let counted = |games: &[(usize, usize)]| {
        request
            .accounts
            .iter()
            .enumerate()
            .map(|(index, account)| OpponentAccountGames {
                account: account.clone(),
                games: games
                    .iter()
                    .find(|(staged_index, _)| *staged_index == index)
                    .map_or(0, |(_, games)| u32::try_from(*games).unwrap_or(u32::MAX)),
            })
            .collect::<Vec<_>>()
    };
    let no_games = |accounts| OpponentImportOutcome::Imported {
        database: None,
        accounts,
        merged: true,
    };

    let mut sources = Vec::with_capacity(staged.len());
    let mut indexes = Vec::with_capacity(staged.len());
    for (index, mut file) in staged {
        if cancellation.is_cancelled() {
            return Err(Error::Cancellation);
        }
        if file.metadata()?.len() == 0 {
            continue;
        }
        file.rewind()?;
        let account = &request.accounts[index];
        sources.push(crate::db::ImportSource::Staged {
            name: format!("{} ({})", account.username, account.provider.label()),
            file,
        });
        indexes.push(index);
    }
    if sources.is_empty() {
        return Ok(no_games(counted(&[])));
    }

    let database = crate::workspace_commands::create_workspace_database_blocking(
        &state.pgn_path_authority,
        request.root.clone(),
        request.filename.clone(),
    )?;
    let usernames: Vec<String> = request
        .accounts
        .iter()
        .map(|account| account.username.clone())
        .collect();
    let imported = crate::db::convert_sources_blocking(
        &state.pgn_path_authority,
        &state.database_repository,
        &state.search_cache,
        sources,
        database.clone(),
        None,
        app,
        request.title.clone(),
        None,
        progress_id,
        cancellation,
        |db| crate::db::merge_players_named(db, &usernames),
    );
    let remove_created = |cause: &str| {
        // Cancellation must not stop the removal of what this operation created.
        if let Err(error) = crate::db::delete_database_blocking(
            &state.pgn_path_authority,
            &state.database_repository,
            &state.search_cache,
            database.clone(),
            &CancellationToken::new(),
        ) {
            log::error!(
                "opponent import could not remove its database after {cause}: {}",
                error.diagnostic()
            );
        }
    };
    match imported {
        Ok(Some((per_source, merged))) => {
            let games: Vec<(usize, usize)> = indexes.into_iter().zip(per_source).collect();
            if games.iter().all(|(_, games)| *games == 0) {
                remove_created("an import without games");
                return Ok(no_games(counted(&[])));
            }
            Ok(OpponentImportOutcome::Imported {
                database: Some(database),
                accounts: counted(&games),
                merged,
            })
        }
        Ok(None) => {
            remove_created("an import without sources");
            Ok(no_games(counted(&[])))
        }
        Err(error) => {
            remove_created("a failed import");
            Err(error)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorCategory;
    use crate::infra::net::{DownloadResponse, DownloadTransport};
    use async_trait::async_trait;
    use bytes::Bytes;
    use reqwest::header::HeaderMap;
    use std::{
        path::{Path, PathBuf},
        sync::{Arc, Mutex},
    };

    type Route = Box<dyn Fn(&str) -> (u16, Vec<u8>) + Send + Sync>;
    type RequestHook = Box<dyn Fn(&str) + Send + Sync>;

    /// Answers by URL and records every request with its Authorization header.
    struct RoutedTransport {
        route: Route,
        before_request: Mutex<Option<RequestHook>>,
        requests: Mutex<Vec<(String, Option<String>)>>,
    }

    #[async_trait]
    impl DownloadTransport for RoutedTransport {
        async fn request(&self, url: &str, headers: HeaderMap) -> Result<DownloadResponse, Error> {
            let authorization = headers
                .get(reqwest::header::AUTHORIZATION)
                .and_then(|value| value.to_str().ok())
                .map(str::to_owned);
            self.requests
                .lock()
                .unwrap()
                .push((url.to_owned(), authorization));
            if let Some(hook) = self.before_request.lock().unwrap().as_ref() {
                hook(url);
            }
            let (status, body) = (self.route)(url);
            Ok(DownloadResponse {
                status,
                headers: HeaderMap::new(),
                content_length: None,
                stream: Box::pin(futures_util::stream::iter(vec![Ok(Bytes::from(body))])),
            })
        }
    }

    struct Fixture {
        state: AppState,
        root: DatabaseRootHandle,
        root_path: PathBuf,
        app: tauri::App<tauri::test::MockRuntime>,
        transport: Arc<RoutedTransport>,
        // Dropped last: the state above holds open database connections inside this directory,
        // and Windows refuses to remove a directory with an open file in it.
        dir: tempfile::TempDir,
    }

    impl Fixture {
        fn new(route: impl Fn(&str) -> (u16, Vec<u8>) + Send + Sync + 'static) -> Self {
            let dir = tempfile::tempdir().unwrap();
            let root_path = dir.path().join("databases");
            std::fs::create_dir(&root_path).unwrap();
            let mut authority = crate::infra::path_authority::PathAuthority::open(
                dir.path().join("registry.json"),
                vec![],
            )
            .unwrap();
            let root = authority
                .get_or_create_database_root(&root_path, "Databases", None)
                .unwrap();
            let transport = Arc::new(RoutedTransport {
                route: Box::new(route),
                before_request: Mutex::new(None),
                requests: Mutex::new(vec![]),
            });
            let state = AppState {
                http_transport: transport.clone(),
                ..Default::default()
            };
            state.pgn_path_authority.install(authority).unwrap();
            let app = tauri::test::mock_app();
            tauri_specta::Builder::<tauri::test::MockRuntime>::new()
                .events(tauri_specta::collect_events!(
                    crate::progress::ProgressEvent,
                    crate::db::ConvertProgress
                ))
                .mount_events(&app);
            Self {
                dir,
                state,
                root,
                root_path,
                app,
                transport,
            }
        }

        /// Binds a credential store; with `stored`, it holds a token and its handle is returned.
        fn sign_in(&mut self, stored: bool) -> LichessAccountHandle {
            let credentials = Arc::new(crate::credentials::CredentialManager::new(Arc::new(
                crate::credentials::MemoryCredentialStore::default(),
            )));
            credentials
                .initialize(&crate::infra::path_authority::AppDataDir::for_test(
                    &self.dir.path().join("credentials-app"),
                ))
                .unwrap();
            let handle = if stored {
                credentials
                    .store_lichess_token("me".into(), "fixture-token".into())
                    .unwrap()
                    .account
                    .handle
            } else {
                LichessAccountHandle::new()
            };
            self.state.credentials = credentials;
            handle
        }

        fn request(
            &self,
            accounts: &[(OpponentProvider, &str)],
            time_controls: &[OpponentTimeControl],
        ) -> OpponentImportRequest {
            OpponentImportRequest {
                root: self.root.clone(),
                filename: "opponent.db3".into(),
                title: "Opponent".into(),
                accounts: accounts
                    .iter()
                    .map(|(provider, username)| OpponentAccount {
                        provider: *provider,
                        username: (*username).into(),
                    })
                    .collect(),
                since_unix_seconds: None,
                time_controls: time_controls.to_vec(),
                lichess_handle: None,
            }
        }

        async fn run(
            &self,
            request: OpponentImportRequest,
        ) -> Result<OpponentImportOutcome, Error> {
            let ticket = self.state.operations.prepare_download("test").unwrap();
            import_opponent_games_runtime(
                request,
                ticket,
                "test",
                self.app.handle().clone(),
                self.state.clone(),
            )
            .await
        }

        fn requests(&self) -> Vec<(String, Option<String>)> {
            self.transport.requests.lock().unwrap().clone()
        }

        fn database_path(&self) -> PathBuf {
            self.root_path.join("opponent.db3")
        }

        fn database_files(&self) -> Vec<String> {
            let mut names: Vec<String> = std::fs::read_dir(&self.root_path)
                .unwrap()
                .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
                .collect();
            names.sort();
            names
        }
    }

    fn count(path: &Path, sql: &str) -> i64 {
        rusqlite::Connection::open(path)
            .unwrap()
            .query_row(sql, [], |row| row.get(0))
            .unwrap()
    }

    fn pgn(site: &str, white: &str, black: &str) -> String {
        format!(
            "[Event \"Rated game\"]\n[Site \"{site}\"]\n[Date \"2026.01.02\"]\n[White \"{white}\"]\n[Black \"{black}\"]\n[Result \"1-0\"]\n\n1. e4 e5 2. Nf3 1-0\n\n"
        )
    }

    fn lichess_body(games: &[(&str, &str, &str)]) -> Vec<u8> {
        games
            .iter()
            .map(|(id, white, black)| pgn(&format!("https://lichess.org/{id}"), white, black))
            .collect::<String>()
            .into_bytes()
    }

    fn chess_com_game(id: u32, white: &str, black: &str) -> serde_json::Value {
        serde_json::json!({
            "pgn": pgn(&format!("https://www.chess.com/game/live/{id}"), white, black),
            "rules": "chess",
            "time_class": "blitz",
            "rated": true,
            "end_time": 1_767_312_000,
        })
    }

    fn archive_index(player: &str, months: &[&str]) -> Vec<u8> {
        let archives: Vec<String> = months
            .iter()
            .map(|month| format!("https://api.chess.com/pub/player/{player}/games/{month}"))
            .collect();
        serde_json::to_vec(&serde_json::json!({ "archives": archives })).unwrap()
    }

    fn archive(games: Vec<serde_json::Value>) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({ "games": games })).unwrap()
    }

    fn imported(outcome: OpponentImportOutcome) -> (Option<DatabaseHandle>, Vec<u32>, bool) {
        match outcome {
            OpponentImportOutcome::Imported {
                database,
                accounts,
                merged,
            } => (
                database,
                accounts.into_iter().map(|account| account.games).collect(),
                merged,
            ),
            OpponentImportOutcome::AccountFailed { account, error } => {
                panic!("account {account:?} failed: {error:?}")
            }
        }
    }

    fn account_failure(outcome: OpponentImportOutcome) -> (OpponentAccount, ErrorPayload) {
        match outcome {
            OpponentImportOutcome::AccountFailed { account, error } => (account, error),
            imported @ OpponentImportOutcome::Imported { .. } => {
                panic!("expected an account failure, got {imported:?}")
            }
        }
    }

    use OpponentProvider::{Chesscom, Lichess};
    use OpponentTimeControl::{Blitz, Bullet, Classical, Correspondence, Rapid};

    #[tokio::test]
    async fn anonymous_export_sends_one_unauthenticated_request_with_the_filter() {
        let fixture = Fixture::new(|_| {
            (
                200,
                lichess_body(&[("aaaaaaaa", "Opp", "x"), ("bbbbbbbb", "y", "Opp")]),
            )
        });
        let mut request = fixture.request(&[(Lichess, "Opp")], &[Blitz, Rapid]);
        request.since_unix_seconds = Some(1_700_000_000);

        let (database, games, merged) = imported(fixture.run(request).await.unwrap());

        assert!(database.is_some());
        assert_eq!(games, [2]);
        assert!(merged);
        let requests = fixture.requests();
        assert_eq!(
            requests.len(),
            1,
            "no coverage or second request: {requests:?}"
        );
        let (url, authorization) = &requests[0];
        assert_eq!(authorization, &None);
        let url = reqwest::Url::parse(url).unwrap();
        assert_eq!(url.path(), "/api/games/user/Opp");
        let query: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(query["perfType"], "blitz,rapid");
        assert_eq!(query["rated"], "true");
        assert_eq!(query["since"], "1700000000000");
        assert_eq!(
            count(&fixture.database_path(), "SELECT COUNT(*) FROM Games"),
            2
        );
    }

    #[tokio::test]
    async fn bullet_and_correspondence_map_to_each_sites_names() {
        let fixture = Fixture::new(|url| {
            if url.contains("lichess.org") {
                (200, lichess_body(&[("aaaaaaaa", "Opp", "x")]))
            } else if url.ends_with("/games/archives") {
                (200, archive_index("opp", &["2026/01"]))
            } else {
                let mut daily = chess_com_game(1, "opp", "x");
                daily["time_class"] = "daily".into();
                let mut bullet = chess_com_game(2, "opp", "y");
                bullet["time_class"] = "bullet".into();
                (
                    200,
                    archive(vec![daily, bullet, chess_com_game(3, "opp", "z")]),
                )
            }
        });
        let request = fixture.request(
            &[(Lichess, "Opp"), (Chesscom, "opp")],
            &[Bullet, Correspondence],
        );

        let (_, games, _) = imported(fixture.run(request).await.unwrap());

        assert_eq!(
            games,
            [1, 2],
            "Chess.com keeps daily and bullet, drops blitz"
        );
        let lichess = reqwest::Url::parse(&fixture.requests()[0].0).unwrap();
        let perfs = lichess
            .query_pairs()
            .find(|(key, _)| key == "perfType")
            .unwrap()
            .1
            .into_owned();
        assert_eq!(perfs, "ultraBullet,bullet,correspondence");
    }

    #[tokio::test]
    async fn a_sign_in_sends_its_token_to_lichess_and_never_to_chess_com() {
        let mut fixture = Fixture::new(|url| {
            if url.contains("lichess.org") {
                (200, lichess_body(&[("aaaaaaaa", "Opp", "x")]))
            } else if url.ends_with("/games/archives") {
                (200, archive_index("opp", &["2026/01"]))
            } else {
                (200, archive(vec![chess_com_game(1, "opp", "x")]))
            }
        });
        let handle = fixture.sign_in(true);
        let mut request = fixture.request(&[(Lichess, "Opp"), (Chesscom, "opp")], &[Blitz]);
        request.lichess_handle = Some(handle);

        let (_, games, _) = imported(fixture.run(request).await.unwrap());

        assert_eq!(games, [1, 1]);
        let requests = fixture.requests();
        assert_eq!(requests.len(), 3);
        assert_eq!(requests[0].1.as_deref(), Some("Bearer fixture-token"));
        assert!(requests[1..]
            .iter()
            .all(|(_, authorization)| authorization.is_none()));
    }

    #[tokio::test]
    async fn a_sign_in_without_a_token_fails_the_account_and_sends_nothing() {
        let mut fixture = Fixture::new(|_| (200, lichess_body(&[("aaaaaaaa", "Opp", "x")])));
        let handle = fixture.sign_in(false);
        let mut request = fixture.request(&[(Lichess, "Opp")], &[Blitz]);
        request.lichess_handle = Some(handle);

        let (account, error) = account_failure(fixture.run(request).await.unwrap());

        assert_eq!(account.username, "Opp");
        assert_eq!(error.category, ErrorCategory::Authentication);
        assert!(error.remote_http_rejection.is_none());
        assert!(fixture.requests().is_empty(), "no anonymous retry");
        assert!(fixture.database_files().is_empty());
    }

    #[tokio::test]
    async fn a_rejected_token_ends_as_that_rejection_without_a_second_request() {
        for (status, category) in [
            (401, ErrorCategory::Authentication),
            (403, ErrorCategory::Permission),
        ] {
            let mut fixture = Fixture::new(move |_| (status, vec![]));
            let handle = fixture.sign_in(true);
            let mut request = fixture.request(&[(Lichess, "Opp")], &[Blitz]);
            request.lichess_handle = Some(handle);

            let (_, error) = account_failure(fixture.run(request).await.unwrap());

            assert_eq!(error.category, category);
            let rejection = error.remote_http_rejection.expect("the site's rejection");
            assert_eq!(rejection.status, status);
            assert!(rejection.authorization_sent);
            assert_eq!(
                fixture.requests().len(),
                1,
                "no anonymous retry after {status}"
            );
            assert!(fixture.database_files().is_empty());
        }
    }

    #[tokio::test]
    async fn a_failure_of_the_second_account_names_it_and_leaves_no_file() {
        for (status, category) in [
            (404, ErrorCategory::MissingResource),
            (429, ErrorCategory::Network),
        ] {
            let fixture = Fixture::new(move |url| {
                if url.contains("lichess.org") {
                    (200, lichess_body(&[("aaaaaaaa", "Opp", "x")]))
                } else {
                    (status, vec![])
                }
            });
            let request = fixture.request(&[(Lichess, "Opp"), (Chesscom, "gone")], &[Blitz]);

            let (account, error) = account_failure(fixture.run(request).await.unwrap());

            assert_eq!(
                account,
                OpponentAccount {
                    provider: Chesscom,
                    username: "gone".into()
                }
            );
            assert_eq!(error.category, category);
            let rejection = error.remote_http_rejection.expect("the site's rejection");
            assert_eq!(rejection.status, status);
            assert!(!rejection.authorization_sent);
            assert!(fixture.database_files().is_empty());
        }
    }

    #[tokio::test]
    async fn chess_com_keeps_only_rated_standard_games_of_the_class_since_the_date() {
        let fixture = Fixture::new(|url| {
            if url.ends_with("/games/archives") {
                (200, archive_index("opp", &["2025/12", "2026/01"]))
            } else {
                assert!(
                    url.ends_with("/2026/01"),
                    "the month before the window was requested: {url}"
                );
                let mut unrated = chess_com_game(2, "opp", "b");
                unrated["rated"] = false.into();
                let mut variant = chess_com_game(3, "opp", "c");
                variant["rules"] = "chess960".into();
                let mut rapid = chess_com_game(4, "opp", "d");
                rapid["time_class"] = "rapid".into();
                let mut early = chess_com_game(5, "opp", "e");
                early["end_time"] = 1_767_225_599.into();
                (
                    200,
                    archive(vec![
                        chess_com_game(1, "opp", "a"),
                        unrated,
                        variant,
                        rapid,
                        early,
                    ]),
                )
            }
        });
        let mut request = fixture.request(&[(Chesscom, "Opp")], &[Blitz]);
        // 2026-01-01T00:00:00Z
        request.since_unix_seconds = Some(1_767_225_600);

        let (_, games, _) = imported(fixture.run(request).await.unwrap());

        assert_eq!(games, [1]);
        assert_eq!(fixture.requests().len(), 2);
        assert_eq!(
            count(&fixture.database_path(), "SELECT COUNT(*) FROM Games"),
            1
        );
    }

    #[tokio::test]
    async fn no_matching_game_reports_zero_and_leaves_no_file() {
        // No archive in the window, an empty archive, and an archive without a kept game.
        for case in 0..3 {
            let fixture = Fixture::new(move |url| {
                if url.contains("lichess.org") {
                    (200, vec![])
                } else if url.ends_with("/games/archives") {
                    (
                        200,
                        archive_index(
                            "opp",
                            if case == 0 {
                                &["2020/01"]
                            } else {
                                &["2026/02"]
                            },
                        ),
                    )
                } else if case == 1 {
                    (200, archive(vec![]))
                } else {
                    let mut unrated = chess_com_game(1, "opp", "a");
                    unrated["rated"] = false.into();
                    (200, archive(vec![unrated]))
                }
            });
            let mut request = fixture.request(&[(Lichess, "Opp"), (Chesscom, "opp")], &[Blitz]);
            request.since_unix_seconds = Some(1_767_225_600);

            let (database, games, _) = imported(fixture.run(request).await.unwrap());

            assert!(database.is_none(), "case {case}");
            assert_eq!(games, [0, 0], "case {case}");
            assert!(fixture.database_files().is_empty(), "case {case}");
        }
    }

    #[tokio::test]
    async fn an_export_without_a_readable_game_reports_zero_and_removes_its_database() {
        // Not empty, so a database is created for it; it holds no game, so the database goes again.
        let fixture = Fixture::new(|_| (200, b"\n\n% no game here\n\n".to_vec()));
        let request = fixture.request(&[(Lichess, "Opp")], &[Blitz]);

        let (database, games, _) = imported(fixture.run(request).await.unwrap());

        assert!(database.is_none());
        assert_eq!(games, [0]);
        assert!(fixture.database_files().is_empty());
    }

    #[tokio::test]
    async fn classical_only_asks_chess_com_for_nothing() {
        let fixture = Fixture::new(|_| (500, vec![]));
        let request = fixture.request(&[(Chesscom, "opp")], &[Classical]);

        let (database, games, _) = imported(fixture.run(request).await.unwrap());

        assert!(database.is_none());
        assert_eq!(games, [0]);
        assert!(fixture.requests().is_empty());
    }

    #[tokio::test]
    async fn an_unreadable_export_fails_the_operation_and_removes_its_database() {
        let fixture = Fixture::new(|_| {
            (
                200,
                b"[Event \"x\"]\n[White \"Opp\"]\n\n1. e4 { never closed".to_vec(),
            )
        });
        let request = fixture.request(&[(Lichess, "Opp")], &[Blitz]);

        let error = fixture.run(request).await.unwrap_err();

        assert!(matches!(error, Error::InvalidInput(_)), "{error:?}");
        assert!(fixture.database_files().is_empty());
    }

    #[tokio::test]
    async fn cancellation_during_the_second_export_leaves_no_file() {
        let fixture = Fixture::new(|url| {
            if url.contains("lichess.org") {
                (200, lichess_body(&[("aaaaaaaa", "Opp", "x")]))
            } else {
                (200, archive_index("opp", &["2026/01"]))
            }
        });
        let ticket = fixture.state.operations.prepare_download("test").unwrap();
        let operations = fixture.state.operations.clone();
        let cancelled_ticket = ticket.clone();
        *fixture.transport.before_request.lock().unwrap() = Some(Box::new(move |url| {
            if url.contains("api.chess.com") {
                operations
                    .cancel_download(&cancelled_ticket, "test")
                    .unwrap();
            }
        }));
        let request = fixture.request(&[(Lichess, "Opp"), (Chesscom, "opp")], &[Blitz]);

        let result = import_opponent_games_runtime(
            request,
            ticket,
            "test",
            fixture.app.handle().clone(),
            fixture.state.clone(),
        )
        .await;

        assert!(matches!(result, Err(Error::Cancellation)), "{result:?}");
        assert!(fixture.database_files().is_empty());
    }

    #[tokio::test]
    async fn linked_usernames_end_as_one_player() {
        // One account spelled two ways, and two different usernames on the two sites.
        let fixture = Fixture::new(|url| {
            if url.contains("lichess.org") {
                (
                    200,
                    lichess_body(&[("aaaaaaaa", "OppLi", "x"), ("bbbbbbbb", "y", "oppli")]),
                )
            } else if url.ends_with("/games/archives") {
                (200, archive_index("oppcc", &["2026/01"]))
            } else {
                (200, archive(vec![chess_com_game(1, "OppCc", "z")]))
            }
        });
        let request = fixture.request(&[(Lichess, "OppLi"), (Chesscom, "oppcc")], &[Blitz]);

        let (_, games, merged) = imported(fixture.run(request).await.unwrap());

        assert_eq!(games, [2, 1]);
        assert!(merged);
        let path = fixture.database_path();
        assert_eq!(
            count(
                &path,
                "SELECT COUNT(*) FROM Players WHERE lower(Name) IN ('oppli', 'oppcc')"
            ),
            1
        );
        assert_eq!(
            count(
                &path,
                "SELECT COUNT(*) FROM Games WHERE WhiteID = (SELECT ID FROM Players WHERE lower(Name) IN ('oppli', 'oppcc')) OR BlackID = (SELECT ID FROM Players WHERE lower(Name) IN ('oppli', 'oppcc'))"
            ),
            3
        );
    }

    #[tokio::test]
    async fn usernames_that_met_stay_separate_and_the_outcome_says_so() {
        let fixture = Fixture::new(|url| {
            if url.contains("lichess.org") {
                (200, lichess_body(&[("aaaaaaaa", "OppLi", "oppcc")]))
            } else if url.ends_with("/games/archives") {
                (200, archive_index("oppcc", &["2026/01"]))
            } else {
                (200, archive(vec![chess_com_game(1, "oppcc", "z")]))
            }
        });
        let request = fixture.request(&[(Lichess, "OppLi"), (Chesscom, "oppcc")], &[Blitz]);

        let (database, games, merged) = imported(fixture.run(request).await.unwrap());

        assert!(database.is_some());
        assert_eq!(games, [1, 1]);
        assert!(!merged);
        assert_eq!(
            count(
                &fixture.database_path(),
                "SELECT COUNT(*) FROM Players WHERE lower(Name) IN ('oppli', 'oppcc')"
            ),
            2
        );
    }

    #[tokio::test]
    async fn an_existing_database_of_that_name_is_refused_and_kept() {
        let fixture = Fixture::new(|_| (200, lichess_body(&[("aaaaaaaa", "Opp", "x")])));
        crate::workspace_commands::create_workspace_database_blocking(
            &fixture.state.pgn_path_authority,
            fixture.root.clone(),
            "opponent.db3".into(),
        )
        .unwrap();
        let request = fixture.request(&[(Lichess, "Opp")], &[Blitz]);

        let error = fixture.run(request).await.unwrap_err();

        assert_eq!(error.category(), ErrorCategory::Conflict, "{error:?}");
        assert_eq!(fixture.database_files(), ["opponent.db3"]);
    }

    #[tokio::test]
    async fn an_invalid_request_is_refused_before_any_request() {
        let fixture = Fixture::new(|_| (200, vec![]));
        let mut duplicate = fixture.request(&[(Lichess, "Opp"), (Lichess, "opp")], &[Blitz]);
        duplicate.title = "Opponent".into();
        let no_controls = fixture.request(&[(Lichess, "Opp")], &[]);
        let bad_name = fixture.request(&[(Chesscom, "a/b")], &[Rapid]);
        let no_accounts = fixture.request(&[], &[Rapid]);
        for request in [duplicate, no_controls, bad_name, no_accounts] {
            let error = fixture.run(request).await.unwrap_err();
            assert!(matches!(error, Error::InvalidInput(_)), "{error:?}");
        }
        assert!(fixture.requests().is_empty());
    }

    #[tokio::test]
    async fn import_opponent_games_waits_on_database_migration_and_succeeds() {
        use crate::infra::path_authority::{FolderSwitchKind, LegacyMigrationCandidate, PathRef};
        use std::collections::HashSet;
        use std::time::Duration;

        let fixture = Fixture::new(|_| (200, lichess_body(&[("aaaaaaaa", "Opp", "x")])));
        let mut gates =
            fixture
                .state
                .folder_switch
                .raise_migration_gates(vec![LegacyMigrationCandidate {
                    kind: FolderSwitchKind::Database,
                    source_root: PathRef {
                        id: "opp-db-mig".into(),
                    },
                    source_identity: (43, 44),
                    source_path: fixture.dir.path().join("databases"),
                    engine_descendants: HashSet::new(),
                }]);
        let (_, gate) = gates.pop().unwrap();

        // 1. A parked opponent import can be cancelled via `cancel_download` while waiting.
        let cancel_ticket = fixture.state.operations.prepare_download("main").unwrap();
        let cancel_req = fixture.request(&[(Lichess, "OppCancel")], &[Blitz]);
        let s_cancel = fixture.state.clone();
        let a_cancel = fixture.app.handle().clone();
        let t_cancel = cancel_ticket.clone();
        let cancel_task = tokio::spawn(async move {
            import_opponent_games_runtime(cancel_req, t_cancel, "main", a_cancel, s_cancel).await
        });

        // 2. A second opponent import waits on the Database gate without claiming a download
        // lease (`has_uninterruptible_work() == false`), then succeeds once the gate releases.
        let ok_ticket = fixture.state.operations.prepare_download("main").unwrap();
        let ok_req = fixture.request(&[(Lichess, "Opp")], &[Blitz]);
        let s_ok = fixture.state.clone();
        let a_ok = fixture.app.handle().clone();
        let ok_task = tokio::spawn(async move {
            import_opponent_games_runtime(ok_req, ok_ticket, "main", a_ok, s_ok).await
        });

        tokio::time::sleep(Duration::from_millis(35)).await;
        assert!(
            !cancel_task.is_finished(),
            "import_opponent_games must park while Database migration gate is raised"
        );
        assert!(
            !ok_task.is_finished(),
            "import_opponent_games must park while Database migration gate is raised"
        );
        assert!(
            !fixture.state.operations.has_uninterruptible_work(),
            "parked import_opponent_games must not hold a claimed download lease before gate releases"
        );

        fixture
            .state
            .operations
            .cancel_download(&cancel_ticket, "main")
            .unwrap();
        let cancelled = tokio::time::timeout(Duration::from_secs(2), cancel_task)
            .await
            .expect("cancel_download must wake parked import_opponent_games")
            .unwrap();
        assert!(
            matches!(cancelled, Err(Error::Cancellation)),
            "expected Error::Cancellation, got {cancelled:?}"
        );

        gate.release();
        let outcome = tokio::time::timeout(Duration::from_secs(10), ok_task)
            .await
            .expect("import_opponent_games must complete after Database gate releases")
            .unwrap()
            .expect("import_opponent_games must succeed after Database gate releases");
        let (database, games, _) = imported(outcome);
        assert!(database.is_some());
        assert_eq!(games, [1]);
    }

    #[tokio::test]
    async fn opponent_import_reports_cumulative_counts_across_two_accounts_and_preserves_count_on_percentage(
    ) {
        use tauri::Listener;
        use tauri_specta::Event;

        let lichess_pgn = concat!(
            "[Event \"L1\"]\n[White \"OppL\"]\n[Black \"B\"]\n[Result \"1-0\"]\n\n1. e4 e5 1-0\n\n",
            "[Event \"L2\"]\n[White \"OppL\"]\n[Black \"B\"]\n[Result \"0-1\"]\n\n1. d4 d5 0-1\n"
        );
        let chesscom_index = serde_json::json!({
            "archives": [
                "https://api.chess.com/pub/player/oppc/games/2026/08",
                "https://api.chess.com/pub/player/oppc/games/2026/09"
            ]
        })
        .to_string();
        let chesscom_m1 = serde_json::json!({
            "games": [
                {"rated": true, "rules": "chess", "time_class": "blitz", "pgn": "[Event \"C1\"]\n[White \"OppC\"]\n[Black \"B\"]\n[Result \"1-0\"]\n\n1. e4 e5 1-0"},
                {"rated": true, "rules": "chess", "time_class": "blitz", "pgn": "[Event \"C2\"]\n[White \"OppC\"]\n[Black \"B\"]\n[Result \"1-0\"]\n\n1. d4 d5 1-0"}
            ]
        })
        .to_string();
        let chesscom_m2 = serde_json::json!({
            "games": [
                {"rated": true, "rules": "chess", "time_class": "blitz", "pgn": "[Event \"C3\"]\n[White \"OppC\"]\n[Black \"B\"]\n[Result \"1-0\"]\n\n1. c4 c5 1-0"}
            ]
        })
        .to_string();

        let fixture = Fixture::new(move |url| {
            if url.starts_with("https://lichess.org/api/games/user/OppL") {
                (200, lichess_pgn.as_bytes().to_vec())
            } else if url == "https://api.chess.com/pub/player/oppc/games/archives" {
                (200, chesscom_index.as_bytes().to_vec())
            } else if url == "https://api.chess.com/pub/player/oppc/games/2026/08" {
                (200, chesscom_m1.as_bytes().to_vec())
            } else if url == "https://api.chess.com/pub/player/oppc/games/2026/09" {
                (200, chesscom_m2.as_bytes().to_vec())
            } else {
                panic!("unexpected URL: {url}")
            }
        });

        let events = Arc::new(Mutex::new(Vec::<crate::progress::ProgressEvent>::new()));
        let recorded = events.clone();
        let listener = fixture
            .app
            .listen_any(crate::progress::ProgressEvent::NAME, move |event| {
                let payload: crate::progress::ProgressEvent =
                    serde_json::from_str(event.payload()).unwrap();
                recorded.lock().unwrap().push(payload);
            });

        let ticket = fixture.state.operations.prepare_download("test").unwrap();
        let request = fixture.request(
            &[
                (OpponentProvider::Lichess, "OppL"),
                (OpponentProvider::Chesscom, "OppC"),
            ],
            &[OpponentTimeControl::Blitz],
        );
        let outcome = import_opponent_games_runtime(
            request,
            ticket.clone(),
            "test",
            fixture.app.handle().clone(),
            fixture.state.clone(),
        )
        .await
        .unwrap();
        let (_, games, _) = imported(outcome);
        assert_eq!(games, [2, 3]);

        let ticket_events: Vec<_> = events
            .lock()
            .unwrap()
            .iter()
            .filter(|e| e.id == ticket)
            .cloned()
            .collect();
        let pct_40 = ticket_events
            .iter()
            .find(|e| (e.progress - 40.0).abs() < 0.01)
            .expect("first per-account percentage update");
        assert_eq!(pct_40.count, Some(2));
        let pct_80 = ticket_events
            .iter()
            .find(|e| (e.progress - 80.0).abs() < 0.01)
            .expect("second per-account percentage update");
        assert_eq!(pct_80.count, Some(5));
        let counts: Vec<u32> = ticket_events.iter().filter_map(|e| e.count).collect();
        assert!(counts.windows(2).all(|w| w[0] <= w[1]), "{counts:?}");
        assert_eq!(
            ticket_events.last().unwrap().state,
            ProgressState::Succeeded
        );
        assert_eq!(ticket_events.last().unwrap().count, Some(5));
        fixture.app.unlisten(listener);
    }

    #[tokio::test]
    async fn opponent_lichess_and_chesscom_count_emission_non_stale_error_continues_and_stale_lease_cancels(
    ) {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let lichess_pgn =
            "[Event \"L1\"]\n[White \"OppL\"]\n[Black \"B\"]\n[Result \"1-0\"]\n\n1. e4 e5 1-0\n";
        let chesscom_index = serde_json::json!({
            "archives": ["https://api.chess.com/pub/player/oppc/games/2026/08"]
        })
        .to_string();
        let chesscom_m1 = serde_json::json!({
            "games": [
                {"rated": true, "rules": "chess", "time_class": "blitz", "pgn": "[Event \"C1\"]\n[White \"OppC\"]\n[Black \"B\"]\n[Result \"1-0\"]\n\n1. e4 e5 1-0"}
            ]
        })
        .to_string();

        for (provider, username) in [
            (OpponentProvider::Lichess, "OppL"),
            (OpponentProvider::Chesscom, "OppC"),
        ] {
            let index = chesscom_index.clone();
            let month = chesscom_m1.clone();
            let fixture = Fixture::new(move |url| {
                if url.starts_with("https://lichess.org/api/games/user/OppL") {
                    (200, lichess_pgn.as_bytes().to_vec())
                } else if url == "https://api.chess.com/pub/player/oppc/games/archives" {
                    (200, index.as_bytes().to_vec())
                } else if url == "https://api.chess.com/pub/player/oppc/games/2026/08" {
                    (200, month.as_bytes().to_vec())
                } else {
                    panic!("unexpected URL: {url}")
                }
            });

            // Non-stale emission error during counting is logged and the import completes.
            let non_stale_hits = Arc::new(AtomicUsize::new(0));
            let hits = non_stale_hits.clone();
            crate::progress::set_running_progress_override(Some(
                move |update: &RunningProgressUpdate| {
                    if update.count.is_some() && hits.fetch_add(1, Ordering::SeqCst) == 0 {
                        Some(Err(Error::Conflict("synthetic emit failure".into())))
                    } else {
                        None
                    }
                },
            ));
            let mut ok_req =
                fixture.request(&[(provider, username)], &[OpponentTimeControl::Blitz]);
            ok_req.filename = format!("ok-{}.db3", provider.label());
            let ok = fixture.run(ok_req).await;
            crate::progress::clear_running_progress_override();
            assert!(
                matches!(ok, Ok(OpponentImportOutcome::Imported { .. })),
                "{} non-stale emission error must not fail opponent import: {ok:?}",
                provider.label()
            );
            assert!(non_stale_hits.load(Ordering::SeqCst) >= 1);

            // Stale lease during counting cancels the operation.
            let stale_hits = Arc::new(AtomicUsize::new(0));
            let hits = stale_hits.clone();
            crate::progress::set_running_progress_override(Some(
                move |update: &RunningProgressUpdate| {
                    if update.count.is_some() && hits.fetch_add(1, Ordering::SeqCst) == 0 {
                        Some(Err(Error::StaleProgressLease))
                    } else {
                        None
                    }
                },
            ));
            let mut stale_req =
                fixture.request(&[(provider, username)], &[OpponentTimeControl::Blitz]);
            stale_req.filename = format!("stale-{}.db3", provider.label());
            let cancelled = fixture.run(stale_req).await;
            crate::progress::clear_running_progress_override();
            assert!(
                matches!(cancelled, Err(Error::Cancellation)),
                "{} stale lease during counting must cancel opponent import: {cancelled:?}",
                provider.label()
            );
            assert!(stale_hits.load(Ordering::SeqCst) >= 1);
        }
    }

    #[tokio::test]
    async fn opponent_per_account_percentage_update_non_stale_error_continues_and_stale_lease_cancels(
    ) {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let lichess_pgn =
            "[Event \"L1\"]\n[White \"OppL\"]\n[Black \"B\"]\n[Result \"1-0\"]\n\n1. e4 e5 1-0\n";
        let fixture = Fixture::new(move |url| {
            if url.starts_with("https://lichess.org/api/games/user/OppL") {
                (200, lichess_pgn.as_bytes().to_vec())
            } else {
                panic!("unexpected URL: {url}")
            }
        });

        // Target only the per-account percentage update (count is None, progress > 0).
        let non_stale_hits = Arc::new(AtomicUsize::new(0));
        let hits = non_stale_hits.clone();
        crate::progress::set_running_progress_override(Some(
            move |update: &RunningProgressUpdate| {
                if update.count.is_none()
                    && update.progress > 0.0
                    && hits.fetch_add(1, Ordering::SeqCst) == 0
                {
                    Some(Err(Error::Conflict("percentage emit failure".into())))
                } else {
                    None
                }
            },
        ));
        let mut ok_req = fixture.request(
            &[(OpponentProvider::Lichess, "OppL")],
            &[OpponentTimeControl::Blitz],
        );
        ok_req.filename = "pct-ok.db3".into();
        let ok = fixture.run(ok_req).await;
        crate::progress::clear_running_progress_override();
        assert!(
            matches!(ok, Ok(OpponentImportOutcome::Imported { .. })),
            "non-stale percentage emission error must not fail opponent import: {ok:?}"
        );
        assert_eq!(non_stale_hits.load(Ordering::SeqCst), 1);

        let stale_hits = Arc::new(AtomicUsize::new(0));
        let hits = stale_hits.clone();
        crate::progress::set_running_progress_override(Some(
            move |update: &RunningProgressUpdate| {
                if update.count.is_none()
                    && update.progress > 0.0
                    && hits.fetch_add(1, Ordering::SeqCst) == 0
                {
                    Some(Err(Error::StaleProgressLease))
                } else {
                    None
                }
            },
        ));
        let mut stale_req = fixture.request(
            &[(OpponentProvider::Lichess, "OppL")],
            &[OpponentTimeControl::Blitz],
        );
        stale_req.filename = "pct-stale.db3".into();
        let cancelled = fixture.run(stale_req).await;
        crate::progress::clear_running_progress_override();
        assert!(
            matches!(cancelled, Err(Error::Cancellation)),
            "stale lease on per-account percentage update must cancel opponent import: {cancelled:?}"
        );
        assert_eq!(stale_hits.load(Ordering::SeqCst), 1);
    }
}
