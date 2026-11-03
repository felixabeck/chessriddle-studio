//! Process-owned account import and its bounded, acknowledgement-retained completion mailbox.

use super::{
    completions::{CompletionChanged, CompletionOutcome},
    *,
};
use crate::{
    credentials::LichessAccountHandle,
    db::linked_collections::MAX_ACCOUNT_NAME_BYTES,
    infra::{
        blocking::BLOCKING_GATEWAY,
        path_authority::{
            ArtifactPublication, CommitDurability, DatabaseHandle, FileWorkspaceHandle, PathRef,
        },
    },
    AppState,
};
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri_specta::Event as _;

const MAX_ACCOUNT_ID_BYTES: usize = 256;
const MAX_ACCOUNT_TITLE_BYTES: usize = 4096;

#[cfg(test)]
pub(crate) static BEFORE_CONVERT: crate::infra::test_hooks::KeyedTestHooks<String> =
    crate::infra::test_hooks::KeyedTestHooks::new();
#[cfg(test)]
pub(crate) static BEFORE_DELETE: crate::infra::test_hooks::KeyedTestHooks<String> =
    crate::infra::test_hooks::KeyedTestHooks::new();
#[cfg(test)]
pub(crate) static DELETE_FAILURE: crate::infra::test_hooks::KeyedTestValues<String, Error> =
    crate::infra::test_hooks::KeyedTestValues::new();

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum AccountImportTarget {
    Linked {
        collection: String,
    },
    Unlinked {
        database: DatabaseHandle,
        title: String,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AccountImportRequest {
    pub provider: String,
    pub account: String,
    pub account_handle: Option<LichessAccountHandle>,
    pub destination: PathRef,
    pub pending_batch: Option<FileWorkspaceHandle>,
    pub since_ms: Option<i64>,
    pub target: AccountImportTarget,
}

impl AccountImportRequest {
    fn validate(&self) -> Result<(), Error> {
        if !matches!(self.provider.as_str(), "lichess" | "chesscom")
            || self.account.is_empty()
            || self.account.len() > MAX_ACCOUNT_NAME_BYTES
            || !self
                .account
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
            || self.destination.id.len() > MAX_ACCOUNT_ID_BYTES
            || self
                .account_handle
                .as_ref()
                .is_some_and(|handle| handle.0.len() > MAX_ACCOUNT_ID_BYTES)
            || matches!(&self.target, AccountImportTarget::Linked { collection } if Uuid::parse_str(collection).is_err())
            || matches!(&self.target, AccountImportTarget::Unlinked { database, title } if database.id.id.len() > MAX_ACCOUNT_ID_BYTES || title.len() > MAX_ACCOUNT_TITLE_BYTES)
            || self
                .pending_batch
                .as_ref()
                .is_some_and(|handle| handle.id.id.len() > MAX_ACCOUNT_ID_BYTES)
        {
            return Err(Error::InvalidInput(
                "invalid account completion request".into(),
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AccountImportResult {
    pub collection_notice: bool,
}

#[derive(Clone, Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AccountCompletion {
    pub id: String,
    pub request: AccountImportRequest,
    pub progress_id: String,
    pub attempt: u32,
    pub outcome: CompletionOutcome<AccountImportResult>,
    pub publication: Option<ArtifactPublication>,
    pub committed_database: Option<DatabaseHandle>,
    pub deletion_pending: bool,
    pub importing: bool,
    #[serde(skip)]
    #[specta(skip)]
    coverage_holds: Option<Vec<crate::lichess::CoverageHold>>,
}

impl AccountCompletion {
    fn needs_retry(&self) -> bool {
        self.deletion_pending
            || (matches!(self.request.target, AccountImportTarget::Unlinked { .. })
                && self.publication.is_some()
                && matches!(self.outcome, CompletionOutcome::Failed(_)))
    }
}

type AccountAttempt = futures_util::future::Shared<
    futures_util::future::BoxFuture<'static, Result<AccountCompletion, Arc<Error>>>,
>;
pub(crate) struct AccountCompletionEntry {
    owner: String,
    snapshot: AccountCompletion,
    attempt: AccountAttempt,
}

pub(crate) struct AccountStart {
    pub(crate) snapshot: AccountCompletion,
    lease: OperationLease,
    result: tokio::sync::oneshot::Sender<Result<AccountCompletion, Arc<Error>>>,
}

impl OperationRegistry {
    pub(crate) fn admit_account_completion(
        &self,
        owner: &str,
        request: AccountImportRequest,
    ) -> Result<(AccountAttempt, Option<AccountStart>), Error> {
        request.validate()?;
        let mut state = self.state()?;
        let existing = state
            .accounts
            .iter()
            .find(|(_, entry)| {
                entry.owner == owner
                    && entry.snapshot.request.provider == request.provider
                    && entry
                        .snapshot
                        .request
                        .account
                        .eq_ignore_ascii_case(&request.account)
            })
            .map(|(id, entry)| (id.clone(), entry.snapshot.clone(), entry.attempt.clone()));
        let mut snapshot = if let Some((_, snapshot, attempt)) = existing {
            if !snapshot.needs_retry() || matches!(snapshot.outcome, CompletionOutcome::Running) {
                return Ok((attempt, None));
            }
            snapshot
        } else {
            if state.accounts.len() >= MAX_ACCEPTED_OPERATIONS {
                return Err(Error::ResourceLimit(
                    "too many unacknowledged account completions".into(),
                ));
            }
            AccountCompletion {
                id: Uuid::new_v4().to_string(),
                request,
                progress_id: Uuid::new_v4().to_string(),
                attempt: 0,
                outcome: CompletionOutcome::Running,
                publication: None,
                committed_database: None,
                deletion_pending: false,
                importing: false,
                coverage_holds: None,
            }
        };
        let lease = self.accept_in_state(
            &mut state,
            &Uuid::new_v4().to_string(),
            "import_account_games",
        )?;
        snapshot.attempt += 1;
        snapshot.outcome = CompletionOutcome::Running;
        let (result, receiver) = tokio::sync::oneshot::channel();
        let attempt = async move {
            receiver.await.unwrap_or_else(|_| {
                Err(Arc::new(Error::Conflict(
                    "account completion result unavailable".into(),
                )))
            })
        }
        .boxed()
        .shared();
        state.accounts.insert(
            snapshot.id.clone(),
            AccountCompletionEntry {
                owner: owner.to_owned(),
                snapshot: snapshot.clone(),
                attempt: attempt.clone(),
            },
        );
        Ok((
            attempt,
            Some(AccountStart {
                snapshot,
                lease,
                result,
            }),
        ))
    }

    pub(crate) fn account_completions(&self, owner: &str) -> Result<Vec<AccountCompletion>, Error> {
        Ok(self
            .state()?
            .accounts
            .values()
            .filter(|entry| entry.owner == owner)
            .map(|entry| entry.snapshot.clone())
            .collect())
    }

    pub(crate) fn update_account_completion(
        &self,
        snapshot: AccountCompletion,
    ) -> Result<(), Error> {
        let mut state = self.state()?;
        let entry = state
            .accounts
            .get_mut(&snapshot.id)
            .ok_or_else(|| Error::Conflict("account completion unavailable".into()))?;
        entry.snapshot = snapshot;
        Ok(())
    }

    pub(crate) fn acknowledge_account_completion(
        &self,
        id: &str,
        owner: &str,
    ) -> Result<(), Error> {
        let mut state = self.state()?;
        let Some(entry) = state.accounts.get(id) else {
            return Ok(());
        };
        if entry.owner != owner {
            return Err(Error::Conflict(
                "completion belongs to another webview".into(),
            ));
        }
        if !entry.snapshot.needs_retry()
            && !matches!(entry.snapshot.outcome, CompletionOutcome::Running)
        {
            state.accounts.remove(id);
        }
        Ok(())
    }
}

#[tauri::command]
#[specta::specta]
pub(crate) fn pending_account_completions(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<AccountCompletion>, Error> {
    state.operations.account_completions(window.label())
}

#[tauri::command]
#[specta::specta]
pub(crate) fn acknowledge_account_completion(
    id: String,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> Result<(), Error> {
    state
        .operations
        .acknowledge_account_completion(&id, window.label())
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn import_account_games(
    request: AccountImportRequest,
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> Result<AccountCompletion, Error> {
    import_account_games_runtime(
        request,
        app,
        window.label().to_owned(),
        state.inner().clone(),
    )
    .await
}

pub(crate) async fn import_account_games_runtime<R: tauri::Runtime>(
    request: AccountImportRequest,
    app: tauri::AppHandle<R>,
    owner: String,
    state: AppState,
) -> Result<AccountCompletion, Error> {
    import_account_games_with_download(request, app, owner, state, download_account).await
}

pub(crate) async fn import_account_games_with_download<R, D, F>(
    request: AccountImportRequest,
    app: tauri::AppHandle<R>,
    owner: String,
    state: AppState,
    download: D,
) -> Result<AccountCompletion, Error>
where
    R: tauri::Runtime,
    D: FnOnce(AccountImportRequest, String, String, tauri::AppHandle<R>, AppState) -> F
        + Send
        + 'static,
    F: Future<Output = Result<RuntimeDownload, Error>> + Send + 'static,
{
    let (attempt, start) = state.operations.admit_account_completion(&owner, request)?;
    if let Some(start) = start {
        start_account_completion(start, app, owner, state, download).await;
    }
    attempt
        .await
        .map_err(|error| Error::Conflict(error.diagnostic()))
}

async fn download_account<R: tauri::Runtime>(
    request: AccountImportRequest,
    ticket: String,
    owner: String,
    app: tauri::AppHandle<R>,
    state: AppState,
) -> Result<RuntimeDownload, Error> {
    let filename = format!("{}_{}.pgn", request.account, request.provider);
    let downloaded = if request.provider == "lichess" {
        let handle = request.account_handle.ok_or_else(|| {
            Error::OAuthFailure("authenticated Lichess account unavailable".into())
        })?;
        crate::fs::download_lichess_games_runtime(
            handle,
            request.destination,
            filename,
            request.account.clone(),
            request.since_ms,
            ticket.clone(),
            &owner,
            &app,
            &state,
        )
        .await
    } else {
        crate::chesscom::download_chess_com_games_runtime(
            request.destination,
            filename,
            request.account.clone(),
            request.since_ms,
            ticket.clone(),
            app,
            &owner,
            state.clone(),
            false,
        )
        .await
    };
    adopt_account_download(downloaded, &request.provider, &request.account)
}

pub(crate) fn adopt_account_download(
    downloaded: Result<RuntimeDownload, Error>,
    provider: &str,
    account: &str,
) -> Result<RuntimeDownload, Error> {
    let mut downloaded = downloaded?;
    if let Some(error) = downloaded.receipt_error.take() {
        log::warn!(
            "account download receipt failed for provider {} account {} publication {}: {}",
            provider,
            account,
            downloaded.publication.handle.path_ref().id,
            error.diagnostic()
        );
    }
    Ok(downloaded)
}

pub(crate) async fn start_account_completion<R, D, F>(
    start: AccountStart,
    app: tauri::AppHandle<R>,
    owner: String,
    state: AppState,
    download: D,
) where
    R: tauri::Runtime,
    D: FnOnce(AccountImportRequest, String, String, tauri::AppHandle<R>, AppState) -> F
        + Send
        + 'static,
    F: Future<Output = Result<RuntimeDownload, Error>> + Send + 'static,
{
    let AccountStart {
        mut snapshot,
        lease,
        result,
    } = start;
    let cancellation = lease.token();
    // Spawn before waiting for the command receiver. All effects and retention belong to this task.
    tokio::spawn(async move {
        let terminal = run_native_operation(lease, "import_account_games", async move {
            let outcome = std::panic::AssertUnwindSafe(async {
                if !snapshot.deletion_pending {
                    if snapshot.publication.is_none() {
                        if let AccountImportTarget::Unlinked { database, .. } =
                            &snapshot.request.target
                        {
                            let database = database.clone();
                            let native = state.clone();
                            snapshot.request.since_ms = BLOCKING_GATEWAY
                                .spawn_cancellable(cancellation.clone(), move |token| {
                                    crate::db::account_sync_cursor_blocking(
                                        &native.pgn_path_authority,
                                        &native.database_repository,
                                        &database,
                                        token,
                                    )
                                })
                                .await?;
                        }
                    }
                    let publication = match (
                        snapshot.publication.clone(),
                        snapshot.request.pending_batch.clone(),
                    ) {
                        (Some(publication), _) => publication,
                        (None, Some(handle)) => ArtifactPublication {
                            handle,
                            durability: CommitDurability::Durable,
                        },
                        (None, None) => {
                            // These reservations belong to the accepted native workflow, so the
                            // starting document cannot cancel them during its reload cleanup.
                            let native_owner = format!("account-workflow:{}", snapshot.id);
                            let ticket = state.operations.prepare_download(&native_owner)?;
                            snapshot.progress_id = ticket.clone();
                            state
                                .operations
                                .update_account_completion(snapshot.clone())?;
                            if let Err(error) = (CompletionChanged {
                                id: snapshot.id.clone(),
                            })
                            .emit_to(&app, &owner)
                            {
                                log::warn!("account progress notification failed: {error}");
                            }
                            let downloaded = download(
                                snapshot.request.clone(),
                                ticket.clone(),
                                native_owner.clone(),
                                app.clone(),
                                state.clone(),
                            )
                            .await;
                            state.operations.release_download(&ticket, &native_owner)?;
                            let downloaded = downloaded?;
                            snapshot.coverage_holds = downloaded.coverage_holds;
                            downloaded.publication
                        }
                    };
                    snapshot.publication = Some(publication.clone());
                    match &snapshot.request.target {
                        AccountImportTarget::Linked { collection } => {
                            let outcome =
                                crate::db::linked_collections::batch::append_collection_batch(
                                    &state,
                                    collection,
                                    publication.handle,
                                    cancellation.clone(),
                                )
                                .await?;
                            return Ok(AccountImportResult {
                                collection_notice: !outcome.index_ready
                                    || !outcome.durability_confirmed,
                            });
                        }
                        AccountImportTarget::Unlinked { database, title } => {
                            let native = state.clone();
                            let database = database.clone();
                            let committed = database.clone();
                            let title = title.clone();
                            let conversion_app = app.clone();
                            let progress_id = format!("conversion:{}", snapshot.id);
                            snapshot.importing = true;
                            state
                                .operations
                                .update_account_completion(snapshot.clone())?;
                            if let Err(error) = (CompletionChanged {
                                id: snapshot.id.clone(),
                            })
                            .emit_to(&app, &owner)
                            {
                                log::warn!("account import notification failed: {error}");
                            }
                            let progress = crate::progress::begin_progress(
                                &state.progress_state,
                                &app,
                                snapshot.progress_id.clone(),
                            )?;
                            let account = crate::db::AccountImportContext {
                                identity: crate::db::linked_collections::AccountIdentity {
                                    provider: snapshot.request.provider.clone(),
                                    account: snapshot.request.account.clone(),
                                },
                                since_ms: snapshot.request.since_ms,
                                coverage_holds: snapshot.coverage_holds.clone(),
                            };
                            #[cfg(test)]
                            let completion_id = snapshot.id.clone();
                            let converted = BLOCKING_GATEWAY
                                .spawn_cancellable(cancellation.clone(), move |token| {
                                    #[cfg(test)]
                                    BEFORE_CONVERT.run(&completion_id);
                                    crate::db::convert_pgn_blocking(
                                        &native.pgn_path_authority,
                                        &native.database_repository,
                                        &native.search_cache,
                                        vec![publication.handle],
                                        database,
                                        Some(account),
                                        conversion_app,
                                        title,
                                        None,
                                        progress_id,
                                        token,
                                    )
                                })
                                .await;
                            let (value, terminal) = if converted.is_ok() {
                                (100.0, crate::progress::ProgressState::Succeeded)
                            } else {
                                (0.0, crate::progress::ProgressState::Failed)
                            };
                            if let Err(error) = crate::progress::update_progress_with_state(
                                &state.progress_state,
                                &app,
                                &progress,
                                value,
                                terminal,
                            ) {
                                log::warn!(
                                    "account import progress update failed: {}",
                                    error.diagnostic()
                                );
                            }
                            converted?;
                            snapshot.committed_database = Some(committed);
                            snapshot.deletion_pending = true;
                        }
                    }
                }
                let database = snapshot.committed_database.clone().ok_or_else(|| {
                    Error::Conflict("committed account database unavailable".into())
                })?;
                let native = state.clone();
                #[cfg(test)]
                let completion_id = snapshot.id.clone();
                BLOCKING_GATEWAY
                    .spawn_cancellable(cancellation, move |token| {
                        #[cfg(test)]
                        {
                            BEFORE_DELETE.run(&completion_id);
                            if let Some(error) = DELETE_FAILURE.take(&completion_id) {
                                return Err(error);
                            }
                        }
                        crate::db::delete_empty_games_blocking(
                            &native.pgn_path_authority,
                            &native.database_repository,
                            &native.search_cache,
                            database,
                            token,
                        )
                    })
                    .await?;
                snapshot.deletion_pending = false;
                Ok(AccountImportResult {
                    collection_notice: false,
                })
            })
            .catch_unwind()
            .await
            .unwrap_or_else(|_| Err(Error::Conflict("account completion worker panicked".into())));
            snapshot.importing = false;
            snapshot.outcome = match outcome {
                Ok(value) => CompletionOutcome::Succeeded(value),
                Err(error) => {
                    log::error!(
                        "account completion {} failed: {}",
                        snapshot.id,
                        error.diagnostic()
                    );
                    CompletionOutcome::Failed(error.renderer_payload())
                }
            };
            state
                .operations
                .update_account_completion(snapshot.clone())?;
            if let Err(error) = (CompletionChanged {
                id: snapshot.id.clone(),
            })
            .emit_to(&app, owner)
            {
                log::warn!("account completion notification failed: {error}");
            }
            Ok(snapshot)
        })
        .await
        .map_err(Arc::new);
        let _ = result.send(terminal);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reload_completion_account_download_uses_provider_runtimes_and_adopts_publication() {
        let body = crate::infra::blocking::source_scan::body_at_indent(
            include_str!("accounts.rs"),
            "async fn download_account<",
        );
        for required in [
            "download_lichess_games_runtime(",
            "download_chess_com_games_runtime(",
            "since_ms",
            "adopt_account_download(downloaded, &request.provider, &request.account)",
        ] {
            assert!(body.contains(required), "missing {required}: {body}");
        }
    }

    #[test]
    fn reload_completion_account_adopts_publication_after_receipt_failure() {
        let publication = ArtifactPublication {
            handle: FileWorkspaceHandle::new(PathRef {
                id: "published-account-download".into(),
            }),
            durability: CommitDurability::Durable,
        };
        let adopted = adopt_account_download(
            Ok(RuntimeDownload {
                publication: publication.clone(),
                receipt_error: Some(Error::Conflict("receipt recording failed".into())),
                coverage_holds: None,
            }),
            "lichess",
            "receipt-failure-account",
        );
        assert_eq!(adopted.unwrap().publication, publication);
    }

    #[test]
    fn reload_completion_provider_runtimes_share_receipt_recording() {
        for (source, signature) in [
            (
                include_str!("../../fs.rs"),
                "async fn download_lichess_games_runtime<",
            ),
            (
                include_str!("../../chesscom.rs"),
                "async fn download_chess_com_games_core<",
            ),
        ] {
            let body = crate::infra::blocking::source_scan::body_at_indent(source, signature);
            assert!(
                body.contains("crate::db::linked_collections::record_download_receipt("),
                "{signature} must use shared receipt recording: {body}"
            );
        }
    }
}
