use std::{
    collections::VecDeque,
    convert::TryFrom,
    path::{Path, PathBuf},
    sync::Arc,
};

use diesel::{dsl::sql, sql_types::Bool, ExpressionMethods, QueryDsl, RunQueryDsl};
use serde::Serialize;
use specta::Type;
use tokio_util::sync::CancellationToken;

use crate::{
    db::{puzzle_themes, puzzles, themes, DatabaseIdentity, DatabaseRepository, Puzzle},
    error::{CommittedRemoval, Error},
    file_workspace::map_picker_join,
    infra::blocking::BLOCKING_GATEWAY,
};

#[derive(Debug, Clone)]
struct PuzzleCacheKey {
    database: DatabaseIdentity,
    database_path: PathBuf,
    min_rating: u16,
    max_rating: u16,
    theme: Option<String>,
}

impl PartialEq for PuzzleCacheKey {
    fn eq(&self, other: &Self) -> bool {
        self.database == other.database
            && self.min_rating == other.min_rating
            && self.max_rating == other.max_rating
            && self.theme == other.theme
    }
}

impl Eq for PuzzleCacheKey {}

#[derive(Debug, Default)]
pub struct PuzzleCache {
    puzzles: VecDeque<Puzzle>,
    key: Option<PuzzleCacheKey>,
}

impl PuzzleCache {
    pub fn new() -> Self {
        Self::default()
    }

    fn take(&mut self, key: &PuzzleCacheKey) -> Option<Puzzle> {
        if self.key.as_ref() == Some(key) {
            self.puzzles.pop_front()
        } else {
            None
        }
    }

    fn replace(&mut self, key: PuzzleCacheKey, puzzles: Vec<Puzzle>) {
        self.key = Some(key);
        self.puzzles = puzzles.into();
    }

    pub fn invalidate_database(&mut self, path: &std::path::Path) {
        if self
            .key
            .as_ref()
            .is_some_and(|key| key.database_path == path)
        {
            self.key = None;
            self.puzzles.clear();
        }
    }
}

fn validate_ratings(min_rating: u16, max_rating: u16) -> Result<(), Error> {
    if min_rating > max_rating {
        return Err(Error::InvalidInput(
            "minimum puzzle rating exceeds maximum rating".into(),
        ));
    }
    Ok(())
}

fn resolve_puzzle(
    state: &crate::AppState,
    file: &crate::infra::path_authority::PathRef,
    operation: crate::infra::path_authority::PathOperation,
) -> Result<crate::infra::path_authority::ResolvedPath, Error> {
    resolve_puzzle_with_authority(&state.pgn_path_authority, file, operation)
}

pub(crate) fn resolve_puzzle_with_authority(
    authority: &crate::infra::path_authority::SharedPathAuthority,
    file: &crate::infra::path_authority::PathRef,
    operation: crate::infra::path_authority::PathOperation,
) -> Result<crate::infra::path_authority::ResolvedPath, Error> {
    authority.with_mut(|authority| authority.resolve(file, operation, &[]))?
}

fn puzzle_binding(
    resolved: &crate::infra::path_authority::ResolvedPath,
) -> Result<(crate::infra::path_authority::DatabaseFileTarget, (u64, u64)), Error> {
    let target = resolved.puzzle_database_target()?;
    let identity = target.identity();
    Ok((target, identity))
}

fn load_puzzles(
    repository: &DatabaseRepository,
    file: crate::infra::inode_ownership::OwnedFile,
    expected_object: (u64, u64),
    min_rating: u16,
    max_rating: u16,
    theme: Option<&str>,
    cancellation: &CancellationToken,
) -> Result<Vec<Puzzle>, Error> {
    let mut database_connection = repository.schema_specific_connection_expected_file_cancellable(
        file,
        expected_object,
        cancellation,
    )?;
    let db = &mut *database_connection;
    let rows = if let Some(theme_name) = theme {
        crate::db::sqlite_cancellation::with_sqlite_cancellation(cancellation, || {
            puzzles::table
                .inner_join(puzzle_themes::table.inner_join(themes::table))
                .filter(themes::name.eq(theme_name))
                .filter(puzzles::rating.le(i32::from(max_rating)))
                .filter(puzzles::rating.ge(i32::from(min_rating)))
                .select(puzzles::all_columns)
                .order(sql::<Bool>("RANDOM()"))
                .limit(20)
                .load::<Puzzle>(db)
        })?
    } else {
        crate::db::sqlite_cancellation::with_sqlite_cancellation(cancellation, || {
            puzzles::table
                .filter(puzzles::rating.le(i32::from(max_rating)))
                .filter(puzzles::rating.ge(i32::from(min_rating)))
                .order(sql::<Bool>("RANDOM()"))
                .limit(20)
                .load::<Puzzle>(db)
        })?
    };
    Ok(rows)
}

fn themes_query_error(error: diesel::result::Error) -> Error {
    if error.to_string().contains("no such table: themes") {
        Error::PuzzleThemesUnavailable
    } else {
        Error::from(error)
    }
}

fn load_puzzle_themes(
    repository: &DatabaseRepository,
    file: crate::infra::inode_ownership::OwnedFile,
    expected_object: (u64, u64),
    cancellation: &CancellationToken,
) -> Result<Vec<String>, Error> {
    let mut database_connection = repository.schema_specific_connection_expected_file_cancellable(
        file,
        expected_object,
        cancellation,
    )?;
    let db = &mut *database_connection;
    crate::db::sqlite_cancellation::with_sqlite_cancellation(cancellation, || {
        themes::table
            .select(themes::name)
            .order(themes::name.asc())
            .load(db)
            .map_err(themes_query_error)
    })
}

fn load_themes_for_puzzle(
    repository: &DatabaseRepository,
    file: crate::infra::inode_ownership::OwnedFile,
    expected_object: (u64, u64),
    puzzle_id: i32,
    cancellation: &CancellationToken,
) -> Result<Vec<String>, Error> {
    let mut database_connection = repository.schema_specific_connection_expected_file_cancellable(
        file,
        expected_object,
        cancellation,
    )?;
    let db = &mut *database_connection;
    crate::db::sqlite_cancellation::with_sqlite_cancellation(cancellation, || {
        themes::table
            .inner_join(puzzle_themes::table)
            .filter(puzzle_themes::puzzle_id.eq(puzzle_id))
            .select(themes::name)
            .order(themes::name.asc())
            .load(db)
            .map_err(themes_query_error)
    })
}

fn puzzle_database_info(
    repository: &DatabaseRepository,
    path: &Path,
    file_handle: crate::infra::inode_ownership::OwnedFile,
    expected_object: (u64, u64),
    file: crate::infra::path_authority::PathRef,
    cancellation: &CancellationToken,
) -> Result<PuzzleDatabaseInfo, Error> {
    let metadata = file_handle.metadata()?;
    let mut database_connection = repository.schema_specific_connection_expected_file_cancellable(
        file_handle,
        expected_object,
        cancellation,
    )?;
    let db = &mut *database_connection;
    let puzzle_count =
        crate::db::sqlite_cancellation::with_sqlite_cancellation(cancellation, || {
            puzzles::table.count().get_result::<i64>(db)
        })?;
    let puzzle_count = i32::try_from(puzzle_count)
        .map_err(|_| Error::ResourceLimit("puzzle count exceeds IPC integer range".into()))?;
    let filename = path
        .file_name()
        .ok_or_else(|| Error::InvalidInput("puzzle database has no filename".into()))?
        .to_string_lossy()
        .into_owned();
    Ok(PuzzleDatabaseInfo {
        title: filename,
        description: String::new(),
        puzzle_count,
        storage_size: metadata.len(),
        path: file,
    })
}

async fn cache_key(
    repository: Arc<DatabaseRepository>,
    resolved: Arc<crate::infra::path_authority::ResolvedPath>,
    min_rating: u16,
    max_rating: u16,
    theme: Option<String>,
    cancellation: CancellationToken,
) -> Result<PuzzleCacheKey, Error> {
    let (database, database_path) = BLOCKING_GATEWAY
        .spawn_cancellable(cancellation, move |token| {
            if token.is_cancelled() {
                return Err(Error::Cancellation);
            }
            let (target, _) = puzzle_binding(&resolved)?;
            let database_path = target.path().to_owned();
            let database = repository.identity_from_probe(&target, token, false)?;
            Ok((database, database_path))
        })
        .await?;
    Ok(PuzzleCacheKey {
        database,
        database_path,
        min_rating,
        max_rating,
        theme,
    })
}

async fn lock_puzzle_cache_cancellable<'a>(
    puzzle_cache: &'a tokio::sync::Mutex<PuzzleCache>,
    cancellation: &CancellationToken,
) -> Result<tokio::sync::MutexGuard<'a, PuzzleCache>, Error> {
    let cache = tokio::select! {
        biased;
        _ = cancellation.cancelled() => return Err(Error::Cancellation),
        cache = puzzle_cache.lock() => cache,
    };
    if cancellation.is_cancelled() {
        return Err(Error::Cancellation);
    }
    Ok(cache)
}

#[tauri::command]
#[specta::specta]
pub async fn get_puzzle(
    file: crate::infra::path_authority::PathRef,
    min_rating: u16,
    max_rating: u16,
    theme: Option<String>,
    ticket: Option<String>,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, crate::AppState>,
) -> Result<Puzzle, Error> {
    let operation = crate::native_read_operation(ticket, &window, &state, "get_puzzle")?;
    let cancellation = operation.token();
    validate_ratings(min_rating, max_rating)?;
    let resolved = Arc::new(resolve_puzzle(
        &state,
        &file,
        crate::infra::path_authority::PathOperation::PuzzleRead,
    )?);
    let repository = state.database_repository.clone();
    let puzzle_cache = Arc::clone(&state.puzzle_cache);
    crate::infra::operations::run_native_operation(operation, "get_puzzle", async move {
        let key = cache_key(
            repository.clone(),
            Arc::clone(&resolved),
            min_rating,
            max_rating,
            theme.clone(),
            cancellation.clone(),
        )
        .await?;

        let mut cache = lock_puzzle_cache_cancellable(&puzzle_cache, &cancellation).await?;
        if let Some(puzzle) = cache.take(&key) {
            return Ok(puzzle);
        }
        drop(cache);

        let fetch_theme = theme.clone();
        let resolved_for_load = Arc::clone(&resolved);
        let new_puzzles = BLOCKING_GATEWAY
            .spawn_cancellable(cancellation.clone(), move |token| {
                let (_target, expected_object) = puzzle_binding(&resolved_for_load)?;
                // Keep the exact authority-opened descriptor alive for the entire
                // SQLite operation; `fetch_path` is backend-only and never crosses IPC.
                let file_handle = resolved_for_load.puzzle_database_file()?;
                let _pinned = resolved_for_load;
                load_puzzles(
                    repository.as_ref(),
                    file_handle,
                    expected_object,
                    min_rating,
                    max_rating,
                    fetch_theme.as_deref(),
                    token,
                )
            })
            .await?;

        let mut cache = lock_puzzle_cache_cancellable(&puzzle_cache, &cancellation).await?;
        // A concurrent request may have populated this exact key while SQLite was
        // loading. Prefer its next item rather than discarding a valid sequence.
        if let Some(puzzle) = cache.take(&key) {
            return Ok(puzzle);
        }
        cache.replace(key.clone(), new_puzzles);
        cache.take(&key).ok_or(Error::NoPuzzles)
    })
    .await
}

#[derive(Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PuzzleDatabaseInfo {
    title: String,
    description: String,
    puzzle_count: i32,
    storage_size: u64,
    path: crate::infra::path_authority::PathRef,
}

/// Refuses an unusable selected root; creates and activates the default only without a selection.
fn active_or_default_puzzle_workspace(
    app_data: &dyn Fn() -> Result<crate::infra::path_authority::AppDataDir, Error>,
    authority: &crate::infra::path_authority::SharedPathAuthority,
) -> Result<crate::infra::path_authority::PuzzleRootDescriptor, Error> {
    authority.with_mut(|authority| {
        if let Some(workspace) = authority.active_puzzle_root()? {
            return Ok(workspace);
        }
        let authorized_dir = crate::infra::path_authority::ensure_app_owned_default_dir(
            &app_data()?,
            crate::infra::path_authority::AppOwnedDefaultRoot::Puzzles,
        )?;
        let root = authority.get_or_create_puzzle_root(
            authorized_dir.path(),
            "Puzzles",
            Some(authorized_dir.identity()),
        )?;
        authority.set_active_puzzle_root(&root)?;
        authority
            .active_puzzle_root()?
            .ok_or_else(|| Error::Conflict("new puzzle workspace became unavailable".into()))
    })?
}

#[tauri::command]
#[specta::specta]
pub async fn issue_puzzle_workspace(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::AppState>,
) -> Result<crate::infra::path_authority::PuzzleRootDescriptor, Error> {
    use tauri_plugin_dialog::DialogExt;
    let path = tokio::task::spawn_blocking(move || {
        app.dialog()
            .file()
            .blocking_pick_folder()
            .ok_or(Error::Cancellation)?
            .into_path()
            .map_err(|error| Error::native_selection("invalid puzzle folder selection", error))
    })
    .await
    .map_err(map_picker_join)??;
    let authority = state.pgn_path_authority.clone();
    crate::infra::operations::run_accepted_blocking(
        &state.operations,
        "issue_puzzle_workspace",
        move || issue_puzzle_workspace_blocking(&authority, path),
    )
    .await
}

fn issue_puzzle_workspace_blocking(
    authority: &crate::infra::path_authority::SharedPathAuthority,
    path: PathBuf,
) -> Result<crate::infra::path_authority::PuzzleRootDescriptor, Error> {
    let display_name = crate::infra::path_authority::selected_root_display_name(&path, "Puzzles");
    authority.with_mut(|authority| {
        let root = authority.get_or_create_puzzle_root(&path, display_name, None)?;
        authority.set_active_puzzle_root(&root)?;
        authority
            .active_puzzle_root()?
            .ok_or_else(|| Error::Conflict("selected puzzle workspace became unavailable".into()))
    })?
}

/// Returns the selected puzzle workspace or refuses an unusable selection. With no selection,
/// creates and activates the app-owned default.
#[tauri::command]
#[specta::specta]
pub async fn get_puzzle_workspace(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::AppState>,
) -> Result<crate::infra::path_authority::PuzzleRootDescriptor, Error> {
    let authority = state.pgn_path_authority.clone();
    // `active_or_default_puzzle_workspace` already holds the whole body, so it is the blocking
    // function; a `get_puzzle_workspace_blocking` forwarding to it would be a pass-through.
    crate::infra::operations::run_accepted_blocking(
        &state.operations,
        "get_puzzle_workspace",
        move || {
            active_or_default_puzzle_workspace(
                &|| crate::infra::path_authority::AppDataDir::for_app(&app),
                &authority,
            )
        },
    )
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn issue_puzzle_download_destination(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::AppState>,
) -> Result<crate::infra::path_authority::PathRef, Error> {
    let authority = state.pgn_path_authority.clone();
    crate::infra::operations::run_accepted_blocking(
        &state.operations,
        "issue_puzzle_download_destination",
        move || issue_puzzle_download_destination_blocking(&authority, app),
    )
    .await
}

fn issue_puzzle_download_destination_blocking<R: tauri::Runtime>(
    authority: &crate::infra::path_authority::SharedPathAuthority,
    app: tauri::AppHandle<R>,
) -> Result<crate::infra::path_authority::PathRef, Error> {
    let workspace = active_or_default_puzzle_workspace(
        &|| crate::infra::path_authority::AppDataDir::for_app(&app),
        authority,
    )?;
    authority.with_mut(|authority| authority.puzzle_download_destination(&workspace.root))?
}

#[tauri::command]
#[specta::specta]
pub async fn list_puzzle_databases(
    app: tauri::AppHandle,
    ticket: Option<String>,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, crate::AppState>,
) -> Result<Vec<PuzzleDatabaseInfo>, Error> {
    let operation = crate::native_read_operation(ticket, &window, &state, "list_puzzle_databases")?;
    let cancellation = operation.token();
    let authority = state.pgn_path_authority.clone();
    let repository = Arc::clone(&state.database_repository);
    crate::infra::operations::run_native_operation(operation, "list_puzzle_databases", async move {
        let worker_authority = authority.clone();
        let files = BLOCKING_GATEWAY
            .spawn_cancellable(cancellation.clone(), move |token| {
                if token.is_cancelled() {
                    return Err(Error::Cancellation);
                }
                let files = list_puzzle_databases_blocking(&app, &worker_authority, token)?;
                if token.is_cancelled() {
                    return Err(Error::Cancellation);
                }
                Ok(files)
            })
            .await?;
        let mut databases = Vec::with_capacity(files.len());
        for file in files {
            if cancellation.is_cancelled() {
                return Err(Error::Cancellation);
            }
            databases.push(
                puzzle_database_info_for_file(
                    authority.clone(),
                    Arc::clone(&repository),
                    file.file,
                    cancellation.clone(),
                )
                .await?,
            );
        }
        if cancellation.is_cancelled() {
            return Err(Error::Cancellation);
        }
        Ok(databases)
    })
    .await
}

fn list_puzzle_databases_blocking<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    authority: &crate::infra::path_authority::SharedPathAuthority,
    cancellation: &CancellationToken,
) -> Result<Vec<crate::infra::path_authority::PuzzleDatabaseDescriptor>, Error> {
    let workspace = active_or_default_puzzle_workspace(
        &|| crate::infra::path_authority::AppDataDir::for_app(app),
        authority,
    )?;
    let result = authority.with_mut(|authority| {
        authority.list_puzzle_children_cancellable(&workspace.root, cancellation)
    })?;
    result.map_err(|error| {
        crate::infra::path_authority::probe_listing_root_failure(
            authority,
            workspace.root.path_ref(),
            crate::infra::path_authority::PathOperation::PuzzleRead,
            error,
            cancellation,
        )
    })
}

async fn puzzle_database_info_for_file(
    authority: crate::infra::path_authority::SharedPathAuthority,
    repository: Arc<DatabaseRepository>,
    file: crate::infra::path_authority::PathRef,
    cancellation: CancellationToken,
) -> Result<PuzzleDatabaseInfo, Error> {
    let resolved = resolve_puzzle_with_authority(
        &authority,
        &file,
        crate::infra::path_authority::PathOperation::PuzzleRead,
    )?;
    let expected_object = resolved.puzzle_database_identity()?;
    let file_handle = resolved.puzzle_database_file()?;
    let path = resolved.puzzle_database_path()?;
    BLOCKING_GATEWAY
        .spawn_cancellable(cancellation, move |token| {
            let _pinned = resolved;
            puzzle_database_info(
                repository.as_ref(),
                &path,
                file_handle,
                expected_object,
                file,
                token,
            )
        })
        .await
}

#[tauri::command]
#[specta::specta]
pub async fn delete_puzzle_database(
    file: crate::infra::path_authority::PathRef,
    state: tauri::State<'_, crate::AppState>,
) -> Result<(), Error> {
    let operation = state.operations.accept("delete_puzzle_database")?;
    let cancellation = operation.token();
    let state = state.inner().clone();
    crate::infra::operations::run_native_operation(
        operation,
        "delete_puzzle_database",
        async move {
            let resolved = resolve_puzzle(
                &state,
                &file,
                crate::infra::path_authority::PathOperation::PuzzleDelete,
            )?;
            let repository = state.database_repository.clone();
            let authority = state.pgn_path_authority.clone();
            delete_puzzle_database_resolved(
                resolved,
                file,
                repository,
                authority,
                Arc::clone(&state.puzzle_cache),
                cancellation,
            )
            .await
        },
    )
    .await
}

async fn delete_puzzle_database_resolved(
    resolved: crate::infra::path_authority::ResolvedPath,
    file: crate::infra::path_authority::PathRef,
    repository: Arc<DatabaseRepository>,
    authority: crate::infra::path_authority::SharedPathAuthority,
    puzzle_cache: Arc<tokio::sync::Mutex<PuzzleCache>>,
    cancellation: tokio_util::sync::CancellationToken,
) -> Result<(), Error> {
    let (committed_removal, deleted_path) = BLOCKING_GATEWAY
        .spawn_cancellable(cancellation, move |token| {
            delete_puzzle_database_blocking(&resolved, &file, &repository, &authority, token)
        })
        .await?;
    finish_puzzle_database_deletion(committed_removal, &deleted_path, &puzzle_cache).await
}

fn delete_puzzle_database_blocking(
    resolved: &crate::infra::path_authority::ResolvedPath,
    file: &crate::infra::path_authority::PathRef,
    repository: &DatabaseRepository,
    authority: &crate::infra::path_authority::SharedPathAuthority,
    token: &CancellationToken,
) -> Result<(CommittedRemoval, PathBuf), Error> {
    let path = resolved.puzzle_database_path()?;
    let delete_resolved = || match resolved.delete_puzzle_database() {
        Ok(()) => Ok(CommittedRemoval::new(1, None)),
        Err(error) if error.is_missing_entry() => Ok(CommittedRemoval::new(0, None)),
        Err(error @ Error::CommittedDurabilityUncertain(_)) => {
            Ok(CommittedRemoval::new(1, Some(error)))
        }
        Err(error) => Err(error),
    };
    let mut committed_removal = match puzzle_binding(resolved) {
        Ok((target, _)) => {
            let mut committed_removal = None;
            let unlink_result = repository.delete_exclusive_cancellable(&target, token, || {
                committed_removal = Some(delete_resolved()?);
                Ok(())
            });
            let Some(mut committed_removal) = committed_removal else {
                unlink_result?;
                return Err(Error::Conflict(
                    "puzzle deletion completed without a committed outcome".into(),
                ));
            };
            committed_removal.record(unlink_result, "puzzle database lease release", &path);
            committed_removal
        }
        Err(error) if error.is_missing_entry() => {
            if token.is_cancelled() {
                return Err(Error::Cancellation);
            }
            delete_resolved()?
        }
        Err(error) => return Err(error),
    };
    let registry_result = authority
        .with_mut(|authority| authority.remove_puzzle_database(file))
        .map_err(Error::from)
        .and_then(|result| result);
    committed_removal.record(registry_result, "puzzle database registry cleanup", &path);
    Ok((committed_removal, path))
}

async fn finish_puzzle_database_deletion(
    committed_removal: CommittedRemoval,
    deleted_path: &Path,
    puzzle_cache: &tokio::sync::Mutex<PuzzleCache>,
) -> Result<(), Error> {
    let mut cache = puzzle_cache.lock().await;
    cache.invalidate_database(deleted_path);
    committed_removal.finish()
}

#[tauri::command]
#[specta::specta]
pub async fn get_puzzle_themes(
    file: crate::infra::path_authority::PathRef,
    ticket: Option<String>,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, crate::AppState>,
) -> Result<Vec<String>, Error> {
    let operation = crate::native_read_operation(ticket, &window, &state, "get_puzzle_themes")?;
    let cancellation = operation.token();
    let resolved = resolve_puzzle(
        &state,
        &file,
        crate::infra::path_authority::PathOperation::PuzzleRead,
    )?;
    let expected_object = resolved.puzzle_database_identity()?;
    let file_handle = resolved.puzzle_database_file()?;
    let repository = state.database_repository.clone();
    crate::infra::operations::run_native_operation(operation, "get_puzzle_themes", async move {
        BLOCKING_GATEWAY
            .spawn_cancellable(cancellation, move |token| {
                let _pinned = resolved;
                load_puzzle_themes(repository.as_ref(), file_handle, expected_object, token)
            })
            .await
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn get_themes_for_puzzle(
    file: crate::infra::path_authority::PathRef,
    puzzle_id: i32,
    ticket: Option<String>,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, crate::AppState>,
) -> Result<Vec<String>, Error> {
    let operation = crate::native_read_operation(ticket, &window, &state, "get_themes_for_puzzle")?;
    let cancellation = operation.token();
    let resolved = resolve_puzzle(
        &state,
        &file,
        crate::infra::path_authority::PathOperation::PuzzleRead,
    )?;
    let expected_object = resolved.puzzle_database_identity()?;
    let file_handle = resolved.puzzle_database_file()?;
    let repository = state.database_repository.clone();
    crate::infra::operations::run_native_operation(operation, "get_themes_for_puzzle", async move {
        BLOCKING_GATEWAY
            .spawn_cancellable(cancellation, move |token| {
                let _pinned = resolved;
                load_themes_for_puzzle(
                    repository.as_ref(),
                    file_handle,
                    expected_object,
                    puzzle_id,
                    token,
                )
            })
            .await
    })
    .await
}

// These tests run on every platform, unlike the unix-only `tests` module below.
#[cfg(test)]
mod workspace_tests {
    use super::*;

    fn puzzle_workspace_body(
        authority: &crate::infra::path_authority::SharedPathAuthority,
        lookup: &dyn Fn() -> Result<crate::infra::path_authority::AppDataDir, Error>,
    ) -> Result<crate::infra::path_authority::PathRef, Error> {
        active_or_default_puzzle_workspace(lookup, authority)
            .map(|workspace| workspace.root.path_ref().clone())
    }

    #[test]
    fn puzzle_workspace_body_creates_and_activates_default_without_selection() {
        use crate::infra::path_authority::{
            portable_tests::assert_workspace_body_defaults_only_without_a_selection,
            AppOwnedDefaultRoot,
        };
        assert_workspace_body_defaults_only_without_a_selection(
            AppOwnedDefaultRoot::Puzzles,
            puzzle_workspace_body,
        );
    }

    #[test]
    fn puzzle_workspace_body_refuses_unusable_selections_without_a_default() {
        use crate::infra::path_authority::{
            portable_tests::assert_workspace_body_refuses_unusable_selections_without_defaults,
            AppOwnedDefaultRoot,
        };
        assert_workspace_body_refuses_unusable_selections_without_defaults(
            AppOwnedDefaultRoot::Puzzles,
            puzzle_workspace_body,
        );
    }

    #[test]
    fn puzzle_workspace_reselection_recovers_from_an_unusable_selection() {
        use crate::error::RootFailure;
        use crate::infra::path_authority::PathAuthority;

        let directory = tempfile::tempdir().unwrap();
        let path_a = directory.path().join("puzzles-a");
        let path_b = directory.path().join("puzzles-b");
        std::fs::create_dir(&path_a).unwrap();
        std::fs::create_dir(&path_b).unwrap();
        let authority = crate::infra::path_authority::SharedPathAuthority::installed(
            PathAuthority::open(directory.path().join("registry.json"), vec![]).unwrap(),
        );

        let workspace_a = issue_puzzle_workspace_blocking(&authority, path_a.clone()).unwrap();
        assert_eq!(workspace_a.display_name, "puzzles-a");
        assert_eq!(
            authority
                .raw_for_test()
                .lock()
                .unwrap()
                .as_mut()
                .unwrap()
                .active_puzzle_root()
                .unwrap(),
            Some(workspace_a)
        );
        std::fs::remove_dir(&path_a).unwrap();
        let looked_up = std::cell::Cell::new(false);
        let lookup = || {
            looked_up.set(true);
            Err(Error::Conflict("unexpected app-data lookup".into()))
        };
        let error = active_or_default_puzzle_workspace(&lookup, &authority).unwrap_err();
        assert_eq!(error.root_failure(), Some(RootFailure::Missing));
        assert!(!looked_up.get());

        let workspace_b = issue_puzzle_workspace_blocking(&authority, path_b).unwrap();
        assert_eq!(
            authority
                .raw_for_test()
                .lock()
                .unwrap()
                .as_mut()
                .unwrap()
                .active_puzzle_root()
                .unwrap(),
            Some(workspace_b.clone())
        );
        assert_eq!(
            active_or_default_puzzle_workspace(&lookup, &authority).unwrap(),
            workspace_b
        );
        assert!(!looked_up.get());

        let error = issue_puzzle_workspace_blocking(&authority, directory.path().join("absent"))
            .unwrap_err();
        assert_eq!(error.root_failure(), None);
        assert_eq!(error.root_failure_reason(), Some(RootFailure::Missing));
        assert_eq!(
            authority
                .raw_for_test()
                .lock()
                .unwrap()
                .as_mut()
                .unwrap()
                .active_puzzle_root()
                .unwrap(),
            Some(workspace_b)
        );
    }
}

#[cfg(test)]
mod deletion_tests {
    use super::*;
    use diesel::connection::SimpleConnection;

    pub(super) fn puzzle_database(
        name: &str,
        rating: i32,
    ) -> (tempfile::TempDir, PathBuf, DatabaseRepository) {
        write_puzzle_database(tempfile::tempdir().unwrap(), Path::new(name), rating)
    }

    pub(super) fn write_puzzle_database(
        directory: tempfile::TempDir,
        relative: &Path,
        rating: i32,
    ) -> (tempfile::TempDir, PathBuf, DatabaseRepository) {
        if let Some(parent) = relative
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
        {
            std::fs::create_dir_all(directory.path().join(parent)).unwrap();
        }
        let path = directory.path().join(relative);
        let repository = DatabaseRepository::default();
        let mut database_connection = repository
            .initialization_connection(&crate::db::test_target(&path), None)
            .unwrap();
        let db = &mut *database_connection;
        db.batch_execute(
            "CREATE TABLE puzzles (id INTEGER PRIMARY KEY, fen TEXT NOT NULL, moves TEXT NOT NULL, rating INTEGER NOT NULL, rating_deviation INTEGER NOT NULL, popularity INTEGER NOT NULL, nb_plays INTEGER NOT NULL);
             CREATE TABLE themes (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
             CREATE TABLE puzzle_themes (puzzle_id INTEGER NOT NULL, theme_id INTEGER NOT NULL);",
        )
        .unwrap();
        db.batch_execute(&format!(
            "INSERT INTO puzzles VALUES (1, 'fen-{rating}', 'e2e4', {rating}, 10, 1, 1); INSERT INTO themes VALUES (1, 'fork'); INSERT INTO puzzle_themes VALUES (1, 1);"
        ))
        .unwrap();
        db.batch_execute(
            "CREATE TABLE snapshot_padding (payload BLOB NOT NULL); INSERT INTO snapshot_padding VALUES (zeroblob(524288));",
        )
        .unwrap();
        db.batch_execute("PRAGMA wal_checkpoint(TRUNCATE);")
            .unwrap();
        drop(database_connection);
        repository
            .close_and_invalidate(&crate::db::test_target(&path))
            .unwrap();
        (directory, path, repository)
    }

    pub(super) struct PuzzleDeletionFixture {
        pub(super) _directory: tempfile::TempDir,
        pub(super) path: PathBuf,
        pub(super) repository: Arc<DatabaseRepository>,
        pub(super) authority: crate::infra::path_authority::SharedPathAuthority,
        pub(super) cache: Arc<tokio::sync::Mutex<PuzzleCache>>,
        pub(super) handle: crate::infra::path_authority::PathRef,
        pub(super) resolved: crate::infra::path_authority::ResolvedPath,
    }

    pub(super) fn puzzle_deletion_fixture(name: &str) -> PuzzleDeletionFixture {
        puzzle_deletion_fixture_at(Path::new(name))
    }

    pub(super) fn puzzle_deletion_fixture_at(relative: &Path) -> PuzzleDeletionFixture {
        let (directory, path, repository) =
            write_puzzle_database(tempfile::tempdir().unwrap(), relative, 1200);
        let registry = directory.path().join("registry.json");
        let mut authority =
            crate::infra::path_authority::PathAuthority::open(registry, vec![]).unwrap();
        let handle = authority
            .get_or_create_persistent_file(
                &path,
                "Puzzle database",
                vec![
                    crate::infra::path_authority::PathOperation::PuzzleRead,
                    crate::infra::path_authority::PathOperation::PuzzleDelete,
                ],
            )
            .unwrap()
            .id;
        let resolved = authority
            .resolve(
                &handle,
                crate::infra::path_authority::PathOperation::PuzzleDelete,
                &[],
            )
            .unwrap();
        let cache_key = PuzzleCacheKey {
            database: repository
                .identity_from_probe(
                    &crate::db::test_target(&path),
                    &CancellationToken::new(),
                    false,
                )
                .unwrap(),
            database_path: resolved.puzzle_database_path().unwrap(),
            min_rating: 0,
            max_rating: u16::MAX,
            theme: None,
        };
        // Windows cannot remove or replace a file held open by an SQLite connection.
        repository
            .close_and_invalidate(&crate::db::test_target(&path))
            .unwrap();
        let mut cache = PuzzleCache::new();
        cache.replace(cache_key, vec![]);
        PuzzleDeletionFixture {
            _directory: directory,
            path,
            repository: Arc::new(repository),
            authority: crate::infra::path_authority::SharedPathAuthority::installed(authority),
            cache: Arc::new(tokio::sync::Mutex::new(cache)),
            handle,
            resolved,
        }
    }

    pub(super) fn authority_contains(
        authority: &crate::infra::path_authority::SharedPathAuthority,
        handle: &crate::infra::path_authority::PathRef,
    ) -> bool {
        authority
            .raw_for_test()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .as_mut()
            .unwrap()
            .descriptors()
            .iter()
            .any(|descriptor| descriptor.id == *handle)
    }

    fn puzzle_cache_rows(
        fixture: &PuzzleDeletionFixture,
        min_rating: u16,
        max_rating: u16,
        theme: Option<&str>,
    ) -> (PuzzleCacheKey, Vec<Puzzle>) {
        let mut key = tauri::async_runtime::block_on(fixture.cache.lock())
            .key
            .clone()
            .unwrap();
        key.min_rating = min_rating;
        key.max_rating = max_rating;
        key.theme = theme.map(str::to_owned);
        let puzzles = load_puzzles(
            &fixture.repository,
            fixture.resolved.puzzle_database_file().unwrap(),
            fixture.resolved.puzzle_database_identity().unwrap(),
            min_rating,
            max_rating,
            theme,
            &CancellationToken::new(),
        )
        .unwrap();
        (key, puzzles)
    }

    #[test]
    fn gl2_captured_cache_take_isolates_rating_and_theme_requests() {
        let fixture = puzzle_deletion_fixture("cache-request-isolation.db3");
        let (key, puzzles) = puzzle_cache_rows(&fixture, 1000, 1500, Some("fork"));
        let requests = [
            (
                "MINIMUM_RATING",
                PuzzleCacheKey {
                    min_rating: 1300,
                    ..key.clone()
                },
            ),
            (
                "MAXIMUM_RATING",
                PuzzleCacheKey {
                    max_rating: 1100,
                    ..key.clone()
                },
            ),
            (
                "THEME",
                PuzzleCacheKey {
                    theme: Some("pin".into()),
                    ..key.clone()
                },
            ),
            (
                "UNTHEMED",
                PuzzleCacheKey {
                    theme: None,
                    ..key.clone()
                },
            ),
        ];
        let diagnostic_alias = PuzzleCacheKey {
            database_path: fixture.path.with_file_name("diagnostic-alias.db3"),
            ..key.clone()
        };
        let mut cache = PuzzleCache::new();
        let mut observations = Vec::new();
        for (dimension, request) in requests {
            cache.replace(key.clone(), puzzles.clone());
            let mismatched = cache.take(&request);
            let matching_alias = cache.take(&diagnostic_alias);
            let exhausted = cache.take(&key);
            observations.push((dimension, mismatched, matching_alias, exhausted));
        }
        cache.replace(key.clone(), puzzles);
        let exact = cache.take(&key);
        let exhausted = cache.take(&key);
        fixture
            .repository
            .close_and_invalidate(&crate::db::test_target(&fixture.path))
            .unwrap();
        let directory = fixture._directory;
        let directory_path = directory.path().to_owned();
        drop(fixture.resolved);
        drop(fixture.repository);
        drop(fixture.authority);
        drop(fixture.cache);
        directory.close().unwrap();

        eprintln!(
            "GL2_CAPTURED_CACHE_CLEANUP: removed={}",
            !directory_path.exists()
        );
        assert!(!directory_path.exists());
        for (dimension, mismatched, matching_alias, exhausted) in observations {
            assert!(mismatched.is_none(), "GL2_CAPTURED_ISOLATION_{dimension}: a different request must not consume a cached puzzle: {mismatched:?}");
            assert_eq!(matching_alias.map(|puzzle| (puzzle.id, puzzle.rating)), Some((1, 1200)), "a refused request must preserve the puzzle for matching identity and filters regardless of diagnostic path");
            assert!(exhausted.is_none());
        }
        assert_eq!(
            exact.map(|puzzle| (puzzle.id, puzzle.rating)),
            Some((1, 1200))
        );
        assert!(exhausted.is_none());
    }

    #[test]
    fn gl2_captured_deletion_retires_cached_puzzles_and_preserves_unrelated() {
        for cache_deleted_database in [true, false] {
            let fixture = puzzle_deletion_fixture("captured-cache-delete.db3");
            let unrelated = puzzle_deletion_fixture("unrelated-cache.db3");
            let cached = if cache_deleted_database {
                &fixture
            } else {
                &unrelated
            };
            let deleted_key = tauri::async_runtime::block_on(fixture.cache.lock())
                .key
                .clone()
                .unwrap();
            let (key, puzzles) = puzzle_cache_rows(cached, 0, u16::MAX, None);
            tauri::async_runtime::block_on(fixture.cache.lock()).replace(key.clone(), puzzles);
            let other_database_request = if cache_deleted_database {
                None
            } else {
                Some(tauri::async_runtime::block_on(fixture.cache.lock()).take(&deleted_key))
            };
            let captured = fixture.resolved.puzzle_database_path().unwrap();
            let unrelated_before = std::fs::read(&unrelated.path).unwrap();
            let result = tauri::async_runtime::block_on(delete_puzzle_database_resolved(
                fixture.resolved,
                fixture.handle.clone(),
                Arc::clone(&fixture.repository),
                fixture.authority.clone(),
                Arc::clone(&fixture.cache),
                CancellationToken::new(),
            ));
            let remaining = tauri::async_runtime::block_on(fixture.cache.lock()).take(&key);
            let deleted = !captured.exists();
            let authority_removed = !authority_contains(&fixture.authority, &fixture.handle);
            let unrelated_after = std::fs::read(&unrelated.path).unwrap();
            unrelated
                .repository
                .close_and_invalidate(&crate::db::test_target(&unrelated.path))
                .unwrap();
            let directory = fixture._directory;
            let unrelated_directory = unrelated._directory;
            let directory_path = directory.path().to_owned();
            let unrelated_directory_path = unrelated_directory.path().to_owned();
            drop(fixture.repository);
            drop(fixture.authority);
            drop(fixture.cache);
            drop(unrelated.resolved);
            drop(unrelated.repository);
            drop(unrelated.authority);
            drop(unrelated.cache);
            directory.close().unwrap();
            unrelated_directory.close().unwrap();

            eprintln!("GL2_CAPTURED_DELETION_CLEANUP: cached_deleted={cache_deleted_database}, result={result:?}, deleted={deleted}, authority_removed={authority_removed}, removed={}/{}", !directory_path.exists(), !unrelated_directory_path.exists());
            assert!(!directory_path.exists() && !unrelated_directory_path.exists());
            assert!(result.is_ok(), "committed deletion completion: {result:?}");
            assert!(deleted && authority_removed);
            assert_eq!(unrelated_before, unrelated_after);
            if cache_deleted_database {
                assert!(remaining.is_none(), "GL2_CAPTURED_CACHE_INVALIDATION: committed deletion must retire the captured object's cached puzzle: {remaining:?}");
            } else {
                assert!(
                    matches!(other_database_request, Some(None)),
                    "GL2_CAPTURED_DATABASE_ISOLATION: an identically filtered request for the deleted database must not consume the unrelated cached puzzle: {other_database_request:?}"
                );
                assert_eq!(
                    remaining.map(|puzzle| (puzzle.id, puzzle.rating)),
                    Some((1, 1200)),
                    "deleting another database must preserve the unrelated cached puzzle"
                );
            }
        }
    }

    #[test]
    fn confirmed_puzzle_deletion_releases_authority_for_same_path_recreation() {
        let (directory, path, repository) = puzzle_database("recreated.db3", 1200);
        let registry = directory.path().join("registry.json");
        let operations = vec![
            crate::infra::path_authority::PathOperation::PuzzleRead,
            crate::infra::path_authority::PathOperation::PuzzleDelete,
        ];
        let mut authority =
            crate::infra::path_authority::PathAuthority::open(registry, vec![]).unwrap();
        let original = authority
            .get_or_create_persistent_file(&path, "Puzzle database", operations.clone())
            .unwrap()
            .id;
        // Windows cannot remove or replace a file held open by an SQLite connection.
        repository
            .close_and_invalidate(&crate::db::test_target(&path))
            .unwrap();
        std::fs::remove_file(&path).unwrap();
        authority.remove_puzzle_database(&original).unwrap();
        std::fs::write(&path, b"replacement database bytes").unwrap();
        let replacement = authority
            .get_or_create_persistent_file(&path, "Puzzle database", operations)
            .unwrap()
            .id;
        assert_ne!(original, replacement);
    }

    #[test]
    fn command_flow_deletes_file_invalidates_cache_and_prunes_authority() {
        let PuzzleDeletionFixture {
            _directory,
            path,
            repository,
            authority,
            cache,
            handle,
            resolved,
        } = puzzle_deletion_fixture("ordinary-delete.db3");

        let result = tauri::async_runtime::block_on(delete_puzzle_database_resolved(
            resolved,
            handle.clone(),
            repository,
            authority.clone(),
            Arc::clone(&cache),
            tokio_util::sync::CancellationToken::new(),
        ));

        assert!(result.is_ok(), "ordinary deletion failed: {result:?}");
        assert!(!path.exists());
        assert!(tauri::async_runtime::block_on(cache.lock()).key.is_none());
        assert!(!authority_contains(&authority, &handle));
    }

    #[test]
    fn command_flow_pre_delete_identity_failure_preserves_file_cache_and_authority() {
        let PuzzleDeletionFixture {
            _directory,
            path,
            repository,
            authority,
            cache,
            handle,
            resolved,
        } = puzzle_deletion_fixture("replaced-before-delete.db3");
        let replacement = path.with_extension("replacement");
        std::fs::write(&replacement, b"replacement puzzle database").unwrap();
        std::fs::remove_file(&path).unwrap();
        std::fs::rename(&replacement, &path).unwrap();

        let result = tauri::async_runtime::block_on(delete_puzzle_database_resolved(
            resolved,
            handle.clone(),
            repository,
            authority.clone(),
            Arc::clone(&cache),
            tokio_util::sync::CancellationToken::new(),
        ));

        assert!(matches!(result, Err(Error::Conflict(_))));
        assert_eq!(
            std::fs::read(&path).unwrap(),
            b"replacement puzzle database"
        );
        assert!(tauri::async_runtime::block_on(cache.lock()).key.is_some());
        assert!(authority_contains(&authority, &handle));
    }

    #[test]
    fn command_flow_treats_already_missing_file_as_deleted() {
        let PuzzleDeletionFixture {
            _directory,
            path,
            repository,
            authority,
            cache,
            handle,
            resolved,
        } = puzzle_deletion_fixture("already-missing.db3");
        std::fs::remove_file(&path).unwrap();

        let result = tauri::async_runtime::block_on(delete_puzzle_database_resolved(
            resolved,
            handle.clone(),
            repository,
            authority.clone(),
            Arc::clone(&cache),
            tokio_util::sync::CancellationToken::new(),
        ));

        assert!(result.is_ok(), "idempotent deletion failed: {result:?}");
        assert!(!path.exists());
        assert!(tauri::async_runtime::block_on(cache.lock()).key.is_none());
        assert!(!authority_contains(&authority, &handle));
    }

    #[test]
    fn command_flow_invalidates_cache_after_delete_even_when_authority_cleanup_fails() {
        let PuzzleDeletionFixture {
            _directory,
            path,
            repository,
            authority,
            cache,
            handle,
            resolved,
        } = puzzle_deletion_fixture("cleanup-failure.db3");
        authority.poison();
        let result = tauri::async_runtime::block_on(delete_puzzle_database_resolved(
            resolved,
            handle.clone(),
            repository,
            authority.clone(),
            Arc::clone(&cache),
            tokio_util::sync::CancellationToken::new(),
        ));

        assert!(matches!(
            result,
            Err(Error::PartialRemoval {
                removed_entries: 1,
                cause,
            }) if matches!(*cause, Error::Conflict(_))
        ));
        assert!(!path.exists(), "physical deletion must remain committed");
        assert!(tauri::async_runtime::block_on(cache.lock()).key.is_none());
        assert!(authority_contains(&authority, &handle));
    }

    #[test]
    fn command_flow_deletion_release_failure_runs_cache_and_registry_cleanup() {
        let fixture = puzzle_deletion_fixture("release-failure.db3");
        fixture.repository.fail_next_deletion_release();

        let result = tauri::async_runtime::block_on(delete_puzzle_database_resolved(
            fixture.resolved,
            fixture.handle.clone(),
            fixture.repository,
            fixture.authority.clone(),
            Arc::clone(&fixture.cache),
            CancellationToken::new(),
        ));

        assert!(
            matches!(result, Err(Error::PartialRemoval { removed_entries: 1, cause })
            if matches!(*cause, Error::Conflict(ref message)
                if message == "injected database deletion release failure"))
        );
        assert!(!fixture.path.exists());
        assert!(tauri::async_runtime::block_on(fixture.cache.lock())
            .key
            .is_none());
        assert!(!authority_contains(&fixture.authority, &fixture.handle));
    }

    #[test]
    fn command_flow_already_missing_file_registry_failure_counts_zero_removed_entries() {
        let fixture = puzzle_deletion_fixture("missing-cleanup-failure.db3");
        std::fs::remove_file(&fixture.path).unwrap();
        fixture.authority.poison();

        let result = tauri::async_runtime::block_on(delete_puzzle_database_resolved(
            fixture.resolved,
            fixture.handle.clone(),
            fixture.repository,
            fixture.authority.clone(),
            Arc::clone(&fixture.cache),
            CancellationToken::new(),
        ));

        assert!(
            matches!(result, Err(Error::PartialRemoval { removed_entries: 0, cause })
            if matches!(*cause, Error::Conflict(ref message)
                if message == "path authority lock was poisoned"))
        );
        assert!(!fixture.path.exists());
        assert!(tauri::async_runtime::block_on(fixture.cache.lock())
            .key
            .is_none());
        assert!(authority_contains(&fixture.authority, &fixture.handle));
    }
}

#[cfg(all(test, unix))]
mod tests {
    use std::time::Duration;

    use diesel::connection::SimpleConnection;

    use super::deletion_tests::*;
    use super::*;
    use tauri::Manager;

    fn delete_puzzle_with_parent_sync_fault_and_log_capture(
        fixture: &PuzzleDeletionFixture,
    ) -> (Result<(), Error>, Vec<crate::error::CapturedLogRecord>) {
        let capture = crate::error::LogCaptureScope::start();
        crate::infra::fs::set_test_removal_injector(Some(Arc::new(
            crate::infra::fs::RemovalFault(crate::infra::fs::RemovalFaultPoint::ParentSync),
        )));
        // Capture on the thread running the blocking tail: the logger's scope is thread-local.
        let result = delete_puzzle_database_blocking(
            &fixture.resolved,
            &fixture.handle,
            &fixture.repository,
            &fixture.authority,
            &CancellationToken::new(),
        );
        crate::infra::fs::set_test_removal_injector(None);
        let result = result.and_then(|(removal, deleted_path)| {
            tauri::async_runtime::block_on(finish_puzzle_database_deletion(
                removal,
                &deleted_path,
                &fixture.cache,
            ))
        });
        (result, capture.records())
    }

    #[test]
    fn command_flow_unlinks_via_retained_parent_when_the_parent_path_is_renamed() {
        let fixture = puzzle_deletion_fixture_at(Path::new("nested/parent-rename.db3"));
        let nested = fixture.path.parent().unwrap().to_owned();
        let moved = nested.with_file_name("moved");
        std::fs::rename(&nested, &moved).unwrap();
        let moved_file = moved.join(fixture.path.file_name().unwrap());
        assert!(moved_file.exists());

        let result = tauri::async_runtime::block_on(delete_puzzle_database_resolved(
            fixture.resolved,
            fixture.handle.clone(),
            fixture.repository,
            fixture.authority.clone(),
            Arc::clone(&fixture.cache),
            tokio_util::sync::CancellationToken::new(),
        ));

        assert!(
            result.is_ok(),
            "retained-parent unlink after parent rename failed: {result:?}"
        );
        assert!(!moved_file.exists());
        assert!(tauri::async_runtime::block_on(fixture.cache.lock())
            .key
            .is_none());
        assert!(!authority_contains(&fixture.authority, &fixture.handle));
    }

    #[test]
    fn puzzle_durability_before_registry_failure_logs_failure_and_invalidates_cache() {
        let fixture = puzzle_deletion_fixture("durability-registry-failure.db3");
        fixture.authority.poison();

        let (result, records) = delete_puzzle_with_parent_sync_fault_and_log_capture(&fixture);

        assert!(matches!(
            result,
            Err(Error::CommittedDurabilityUncertain(
                crate::error::DurabilityStage::WorkspaceRemoval
            ))
        ));
        assert!(!fixture.path.exists());
        assert!(tauri::async_runtime::block_on(fixture.cache.lock())
            .key
            .is_none());
        assert!(authority_contains(&fixture.authority, &fixture.handle));
        assert!(records.iter().any(|record| record.level == log::Level::Warn
            && record
                .message
                .contains("puzzle database registry cleanup failed after durability uncertainty")
            && record.message.contains("kept category: Durability")
            && record
                .message
                .contains("Conflict: path authority lock was poisoned")));
    }

    #[test]
    fn puzzle_durability_before_deletion_release_failure_logs_failure_and_runs_cleanup() {
        let fixture = puzzle_deletion_fixture("durability-release-failure.db3");
        fixture.repository.fail_next_deletion_release();

        let (result, records) = delete_puzzle_with_parent_sync_fault_and_log_capture(&fixture);

        assert!(matches!(
            result,
            Err(Error::CommittedDurabilityUncertain(
                crate::error::DurabilityStage::WorkspaceRemoval
            ))
        ));
        assert!(!fixture.path.exists());
        assert!(tauri::async_runtime::block_on(fixture.cache.lock())
            .key
            .is_none());
        assert!(!authority_contains(&fixture.authority, &fixture.handle));
        assert!(records.iter().any(|record| record.level == log::Level::Warn
            && record
                .message
                .contains("puzzle database lease release failed after durability uncertainty")
            && record.message.contains("kept category: Durability")
            && record
                .message
                .contains("Conflict: injected database deletion release failure")));
    }

    #[test]
    fn alternate_databases_and_short_sets_never_reuse_a_stale_puzzle() {
        let (_one_dir, one_path, one_repository) = puzzle_database("one.db", 1200);
        let (_two_dir, two_path, two_repository) = puzzle_database("two.db", 2200);
        let one_identity = one_repository
            .identity_from_probe(
                &crate::db::test_target(&one_path),
                &CancellationToken::new(),
                false,
            )
            .unwrap();
        let two_identity = two_repository
            .identity_from_probe(
                &crate::db::test_target(&two_path),
                &CancellationToken::new(),
                false,
            )
            .unwrap();
        let one_key = PuzzleCacheKey {
            database: one_identity,
            database_path: one_path.clone(),
            min_rating: 1000,
            max_rating: 1500,
            theme: None,
        };
        let two_key = PuzzleCacheKey {
            database: two_identity,
            database_path: two_path.clone(),
            min_rating: 2000,
            max_rating: 2500,
            theme: Some("fork".into()),
        };
        let one_object = crate::infra::path_authority::opened_file_identity(
            &crate::infra::inode_ownership::OwnedFile::open(&one_path).unwrap(),
        )
        .unwrap();
        let one = load_puzzles(
            &one_repository,
            crate::infra::inode_ownership::OwnedFile::open(&one_path).unwrap(),
            one_object,
            1000,
            1500,
            None,
            &CancellationToken::new(),
        )
        .unwrap();
        assert_eq!(one.len(), 1);
        let two_object = crate::infra::path_authority::opened_file_identity(
            &crate::infra::inode_ownership::OwnedFile::open(&two_path).unwrap(),
        )
        .unwrap();
        let two = load_puzzles(
            &two_repository,
            crate::infra::inode_ownership::OwnedFile::open(&two_path).unwrap(),
            two_object,
            2000,
            2500,
            Some("fork"),
            &CancellationToken::new(),
        )
        .unwrap();
        assert_eq!(two.len(), 1);

        let mut cache = PuzzleCache::new();
        cache.replace(one_key.clone(), one);
        assert_eq!(cache.take(&one_key).unwrap().rating, 1200);
        assert!(cache.take(&one_key).is_none());
        cache.replace(two_key.clone(), two);
        assert_eq!(cache.take(&two_key).unwrap().rating, 2200);
    }

    #[test]
    fn database_invalidation_removes_only_that_database_cache_entry() {
        let (_dir, path, repository) = puzzle_database("one.db", 1200);
        let key = PuzzleCacheKey {
            database: repository
                .identity_from_probe(
                    &crate::db::test_target(&path),
                    &CancellationToken::new(),
                    false,
                )
                .unwrap(),
            database_path: path.clone(),
            min_rating: 0,
            max_rating: u16::MAX,
            theme: None,
        };
        let different_range = PuzzleCacheKey {
            min_rating: 1000,
            ..key.clone()
        };
        let mut cache = PuzzleCache::new();
        cache.replace(key, vec![]);
        assert!(cache.take(&different_range).is_none());
        cache.invalidate_database(&path.with_file_name("other.db"));
        assert!(cache.key.is_some());
        cache.invalidate_database(&path.canonicalize().unwrap());
        assert!(cache.key.is_none());
    }

    #[test]
    fn invalid_rating_range_is_rejected_before_querying() {
        assert!(validate_ratings(2000, 1000).is_err());
    }

    #[test]
    fn valid_rating_range_is_accepted() {
        assert!(validate_ratings(1000, 2000).is_ok());
        assert!(validate_ratings(1500, 1500).is_ok());
    }

    fn assert_cancelled_during_snapshot_copy<T>(
        path: &Path,
        _repository: &DatabaseRepository,
        run: impl FnOnce(
            crate::infra::inode_ownership::OwnedFile,
            (u64, u64),
            &CancellationToken,
        ) -> Result<T, Error>,
    ) {
        let file = crate::infra::inode_ownership::OwnedFile::open(path).unwrap();
        let object = crate::infra::path_authority::opened_file_identity(&file).unwrap();
        let cancellation = CancellationToken::new();
        crate::db::cancel_snapshot_copy_after_chunks(cancellation.clone(), 2);
        assert!(matches!(
            run(file, object, &cancellation),
            Err(Error::Cancellation)
        ));
    }

    #[test]
    fn get_puzzle_production_query_cancels_during_authority_snapshot_copy() {
        let (_directory, path, repository) = puzzle_database("get-puzzle-copy.db3", 1200);
        assert_cancelled_during_snapshot_copy(&path, &repository, |file, object, token| {
            load_puzzles(&repository, file, object, 0, u16::MAX, None, token)
        });
    }

    #[test]
    fn list_puzzle_databases_production_info_step_cancels_during_snapshot_copy() {
        let fixture = puzzle_deletion_fixture("list-copy.db3");
        assert_cancelled_during_snapshot_copy(
            &fixture.path,
            &fixture.repository,
            |file, object, token| {
                puzzle_database_info(
                    &fixture.repository,
                    &fixture.path,
                    file,
                    object,
                    fixture.handle.clone(),
                    token,
                )
            },
        );
    }

    #[test]
    fn get_puzzle_themes_production_core_cancels_during_snapshot_copy() {
        let (_directory, path, repository) = puzzle_database("themes-copy.db3", 1200);
        assert_cancelled_during_snapshot_copy(&path, &repository, |file, object, token| {
            load_puzzle_themes(&repository, file, object, token)
        });
    }

    #[test]
    fn get_themes_for_puzzle_production_core_cancels_during_snapshot_copy() {
        let (_directory, path, repository) = puzzle_database("puzzle-themes-copy.db3", 1200);
        assert_cancelled_during_snapshot_copy(&path, &repository, |file, object, token| {
            load_themes_for_puzzle(&repository, file, object, 1, token)
        });
    }

    #[test]
    fn real_random_and_count_queries_cancel_at_sqlite_checkpoints() {
        let fixture = puzzle_deletion_fixture("sql-cancel.db3");
        for run_count in [false, true] {
            let file = crate::infra::inode_ownership::OwnedFile::open(&fixture.path).unwrap();
            let object = crate::infra::path_authority::opened_file_identity(&file).unwrap();
            let cancellation = CancellationToken::new();
            let checkpoints =
                crate::db::sqlite_cancellation::cancel_on_callback(cancellation.clone(), 2);
            let result = if run_count {
                puzzle_database_info(
                    &fixture.repository,
                    &fixture.path,
                    file,
                    object,
                    fixture.handle.clone(),
                    &cancellation,
                )
                .map(|_| ())
            } else {
                load_puzzles(
                    &fixture.repository,
                    file,
                    object,
                    0,
                    u16::MAX,
                    None,
                    &cancellation,
                )
                .map(|_| ())
            };
            assert!(matches!(result, Err(Error::Cancellation)));
            assert!(checkpoints.load(std::sync::atomic::Ordering::SeqCst) >= 2);
        }
    }

    #[tokio::test]
    async fn cancellation_while_waiting_for_puzzle_cache_never_consumes_or_mutates_it() {
        let cache = Arc::new(tokio::sync::Mutex::new(PuzzleCache::new()));
        let held = cache.lock().await;
        let cancellation = CancellationToken::new();
        let worker_cache = Arc::clone(&cache);
        let worker_token = cancellation.clone();
        let worker = tokio::spawn(async move {
            lock_puzzle_cache_cancellable(&worker_cache, &worker_token)
                .await
                .map(|mut cache| cache.key.take())
        });
        cancellation.cancel();
        let result = tokio::time::timeout(Duration::from_secs(1), worker)
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(result, Err(Error::Cancellation)));
        assert!(held.key.is_none());
    }

    #[tokio::test]
    async fn lock_puzzle_cache_cancellable_returns_the_guard_when_the_token_is_live() {
        let cache = Arc::new(tokio::sync::Mutex::new(PuzzleCache::new()));
        let guard = lock_puzzle_cache_cancellable(&cache, &CancellationToken::new())
            .await
            .expect("a live token must acquire the cache");
        assert!(guard.key.is_none());
    }

    #[test]
    fn puzzle_capability_is_operation_specific_and_replacement_is_rejected() {
        let (directory, path, _repository) = puzzle_database("one.db3", 1200);
        let mut authority = crate::infra::path_authority::PathAuthority::open(
            directory.path().join("registry.json"),
            vec![],
        )
        .unwrap();
        let capability = authority
            .grant_dialog_operations(
                &path,
                "Puzzle database",
                crate::infra::path_authority::PathClass::BoundedDialogGrant,
                vec![crate::infra::path_authority::PathOperation::PuzzleRead],
                Duration::from_secs(60),
                4,
            )
            .unwrap();
        let resolved = authority
            .resolve(
                &capability,
                crate::infra::path_authority::PathOperation::PuzzleRead,
                &[],
            )
            .unwrap();
        assert_eq!(resolved.puzzle_database_path().unwrap(), path);
        let target = resolved.puzzle_database_target().unwrap();
        assert_eq!(target.path(), path.canonicalize().unwrap());
        assert!(authority
            .resolve(
                &capability,
                crate::infra::path_authority::PathOperation::PuzzleDelete,
                &[],
            )
            .is_err());

        std::fs::remove_file(&path).unwrap();
        std::fs::write(&path, b"replacement").unwrap();
        assert!(authority
            .resolve(
                &capability,
                crate::infra::path_authority::PathOperation::PuzzleRead,
                &[],
            )
            .is_err());
    }

    #[test]
    fn persistent_puzzle_descriptor_survives_restart_and_rejects_replacement() {
        let (directory, path, _repository) = puzzle_database("persistent.db3", 1200);
        let registry = directory.path().join("registry.json");
        let operations = vec![
            crate::infra::path_authority::PathOperation::PuzzleRead,
            crate::infra::path_authority::PathOperation::PuzzleDelete,
        ];
        let first = crate::infra::path_authority::PathAuthority::open(registry.clone(), vec![])
            .unwrap()
            .get_or_create_persistent_file(&path, "Persistent puzzle database", operations.clone())
            .unwrap();
        let mut reopened =
            crate::infra::path_authority::PathAuthority::open(registry, vec![]).unwrap();
        let second = reopened
            .get_or_create_persistent_file(&path, "Persistent puzzle database", operations.clone())
            .unwrap();
        assert_eq!(first.id, second.id);

        let replacement = directory.path().join("replacement.db3");
        std::fs::write(&replacement, b"replacement").unwrap();
        std::fs::rename(replacement, &path).unwrap();
        assert!(reopened
            .get_or_create_persistent_file(&path, "Persistent puzzle database", operations)
            .is_err());
    }

    #[test]
    fn command_flow_puzzle_delete_cleans_up_after_durability_uncertainty() {
        let PuzzleDeletionFixture {
            _directory,
            path,
            repository,
            authority,
            cache,
            handle,
            resolved,
        } = puzzle_deletion_fixture("durability-uncertain-delete.db3");
        crate::infra::fs::set_test_removal_injector(Some(Arc::new(
            crate::infra::fs::RemovalFault(crate::infra::fs::RemovalFaultPoint::ParentSync),
        )));
        let result = tauri::async_runtime::block_on(delete_puzzle_database_resolved(
            resolved,
            handle.clone(),
            repository,
            authority.clone(),
            Arc::clone(&cache),
            tokio_util::sync::CancellationToken::new(),
        ));
        crate::infra::fs::set_test_removal_injector(None);

        assert!(matches!(
            result,
            Err(Error::CommittedDurabilityUncertain(_))
        ));
        assert!(!path.exists());
        assert!(tauri::async_runtime::block_on(cache.lock()).key.is_none());
        assert!(!authority_contains(&authority, &handle));
    }

    struct RefusedDeletionFixture<C> {
        _directory: tempfile::TempDir,
        path: PathBuf,
        repository: Arc<DatabaseRepository>,
        handle: crate::infra::path_authority::PathRef,
        target: crate::infra::path_authority::DatabaseFileTarget,
        held_connection: C,
        app: tauri::App<tauri::test::MockRuntime>,
    }

    async fn refused_deletion_fixture(
        name: &str,
    ) -> RefusedDeletionFixture<impl std::ops::DerefMut<Target = diesel::SqliteConnection>> {
        let PuzzleDeletionFixture {
            _directory,
            path,
            repository,
            authority,
            cache,
            handle,
            resolved,
        } = puzzle_deletion_fixture(name);
        drop(resolved);
        let target = crate::db::test_target(&path);
        let held_connection = repository.schema_specific_connection(&target).unwrap();
        let state = crate::AppState {
            database_repository: Arc::clone(&repository),
            pgn_path_authority: authority.clone(),
            puzzle_cache: Arc::clone(&cache),
            ..Default::default()
        };
        let app = tauri::test::mock_app();
        app.manage(state);
        let result = delete_puzzle_database(handle.clone(), app.state::<crate::AppState>()).await;
        assert!(
            matches!(result, Err(Error::Conflict(_))),
            "ordinary puzzle deletion must refuse a live game binding"
        );
        assert!(path.exists());
        assert!(cache.lock().await.key.is_some());
        assert!(app
            .state::<crate::AppState>()
            .operations
            .outstanding_labels()
            .unwrap()
            .is_empty());

        RefusedDeletionFixture {
            _directory,
            path,
            repository,
            handle,
            target,
            held_connection,
            app,
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cross_capability_puzzle_delete_refuses_game_binding_and_retries() {
        let RefusedDeletionFixture {
            _directory,
            path,
            repository,
            handle,
            target,
            held_connection,
            app,
        } = refused_deletion_fixture(
            "cross_capability_puzzle_delete_refuses_game_binding_and_retries.db3",
        )
        .await;
        drop(held_connection);
        repository.close_and_invalidate(&target).unwrap();
        delete_puzzle_database(handle, app.state::<crate::AppState>())
            .await
            .unwrap();
        assert!(!path.exists());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cross_capability_puzzle_delete_refusal_leaves_shutdown_no_native_job() {
        let RefusedDeletionFixture {
            _directory,
            repository,
            target,
            held_connection,
            app,
            ..
        } = refused_deletion_fixture(
            "cross_capability_puzzle_delete_refusal_leaves_shutdown_no_native_job.db3",
        )
        .await;
        app.state::<crate::AppState>()
            .operations
            .seal_and_request_cancellation()
            .unwrap();
        drop(held_connection);
        repository.close_and_invalidate(&target).unwrap();
    }

    #[test]
    fn cache_key_uses_the_resolved_puzzle_binding() {
        let fixture = puzzle_deletion_fixture("cache-key.db3");
        let expected = crate::infra::path_authority::opened_file_identity(
            &crate::infra::inode_ownership::OwnedFile::open(&fixture.path).unwrap(),
        )
        .unwrap();
        let (target, identity) = puzzle_binding(&fixture.resolved).unwrap();
        assert_eq!(identity, expected);
        assert_eq!(target.path(), fixture.path.canonicalize().unwrap());
        let key = tauri::async_runtime::block_on(cache_key(
            Arc::clone(&fixture.repository),
            Arc::new(fixture.resolved),
            0,
            u16::MAX,
            None,
            CancellationToken::new(),
        ))
        .unwrap();
        assert_eq!(key.database.object, expected);
        assert_eq!(key.min_rating, 0);
        assert_eq!(key.max_rating, u16::MAX);
        assert!(key.theme.is_none());
    }

    #[test]
    fn joiner_puzzle_retained_parent_mints_cache_and_loads_original_after_rename() {
        for substitute in [false, true] {
            let fixture = puzzle_deletion_fixture_at(Path::new("parent/puzzles.db3"));
            let original_parent = fixture.path.parent().unwrap();
            let moved = fixture._directory.path().join("moved-parent");
            let renamed = std::fs::rename(original_parent, &moved);
            #[cfg(windows)]
            {
                assert!(
                    renamed.is_err(),
                    "retained Windows handles must refuse parent replacement"
                );
            }
            #[cfg(unix)]
            {
                renamed.unwrap();
                if substitute {
                    std::fs::create_dir(original_parent).unwrap();
                    std::fs::write(&fixture.path, b"substitute is not a puzzle database").unwrap();
                }
            }
            let (target, expected) = puzzle_binding(&fixture.resolved)
                .expect("mint from the retained parent after rename");
            assert_eq!(target.probe_current().unwrap().identity, expected);
            let key = tauri::async_runtime::block_on(cache_key(
                Arc::clone(&fixture.repository),
                Arc::new(fixture.resolved),
                0,
                u16::MAX,
                None,
                CancellationToken::new(),
            ))
            .expect("cache key probes the original parent");
            assert_eq!(key.database.object, expected, "substitution {substitute}");
            let file = crate::infra::fs::open_regular_at(
                target.parent(),
                target.leaf(),
                crate::infra::fs::RegularFileAccess::ReadOnly,
            )
            .unwrap();
            let rows = load_puzzles(
                &fixture.repository,
                file,
                expected,
                0,
                u16::MAX,
                None,
                &CancellationToken::new(),
            )
            .unwrap();
            assert_eq!(rows.len(), 1);
            assert_eq!(rows[0].rating, 1200);
            #[cfg(unix)]
            if substitute {
                assert_eq!(
                    std::fs::read(&fixture.path).unwrap(),
                    b"substitute is not a puzzle database"
                );
            } else {
                assert!(!fixture.path.exists());
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn joiner_puzzle_retained_parent_keeps_repository_deletion_exclusion() {
        let fixture = puzzle_deletion_fixture_at(Path::new("parent/puzzles.db3"));
        let (target, _) = puzzle_binding(&fixture.resolved).unwrap();
        // Retain the sealed carrier while releasing the ordinary file lease before opening
        // SQLite. Ordinary capability/SQLite exclusion is an independent existing contract.
        drop(fixture.resolved);
        let connection = fixture
            .repository
            .schema_specific_connection(&target)
            .unwrap();
        let moved = fixture._directory.path().join("moved-parent");
        std::fs::rename(fixture.path.parent().unwrap(), &moved).unwrap();
        assert_eq!(target.probe_current().unwrap().identity, target.identity());
        let called = std::sync::atomic::AtomicBool::new(false);
        let cancellation = CancellationToken::new();
        std::thread::scope(|scope| {
            let _cancel_on_exit = cancellation.clone().drop_guard();
            let worker = scope.spawn(|| {
                fixture
                    .repository
                    .delete_exclusive_cancellable(&target, &cancellation, || {
                        called.store(true, std::sync::atomic::Ordering::SeqCst);
                        crate::infra::fs::remove_entry_at(
                            target.parent(),
                            target.leaf(),
                            target.identity(),
                            false,
                        )
                    })
            });
            let deadline = std::time::Instant::now() + Duration::from_secs(5);
            while !fixture.repository.deletion_is_waiting(&target).unwrap() {
                assert!(
                    !worker.is_finished(),
                    "deletion must wait for the live repository lease"
                );
                assert!(
                    std::time::Instant::now() < deadline,
                    "deletion must enter its existing lease wait"
                );
                std::thread::yield_now();
            }
            cancellation.cancel();
            assert!(matches!(worker.join().unwrap(), Err(Error::Cancellation)));
        });
        assert!(!called.load(std::sync::atomic::Ordering::SeqCst));
        assert!(moved.join("puzzles.db3").exists());
        drop(connection);
        fixture
            .repository
            .delete_exclusive(&target, || {
                crate::infra::fs::remove_entry_at(
                    target.parent(),
                    target.leaf(),
                    target.identity(),
                    false,
                )
            })
            .unwrap();
        assert!(!moved.join("puzzles.db3").exists());
    }

    #[cfg(unix)]
    #[test]
    fn joiner_puzzle_retained_probe_refuses_changed_or_missing_leaf_after_rename() {
        for replacement in ["missing", "file", "directory", "symlink"] {
            let fixture = puzzle_deletion_fixture_at(Path::new("parent/puzzles.db3"));
            let (target, _) = puzzle_binding(&fixture.resolved).unwrap();
            let moved = fixture._directory.path().join("moved-parent");
            std::fs::rename(fixture.path.parent().unwrap(), &moved).unwrap();
            std::fs::rename(moved.join("puzzles.db3"), moved.join("original.db3")).unwrap();
            match replacement {
                "file" => std::fs::write(moved.join("puzzles.db3"), b"different object").unwrap(),
                "directory" => std::fs::create_dir(moved.join("puzzles.db3")).unwrap(),
                "symlink" => std::os::unix::fs::symlink(
                    moved.join("original.db3"),
                    moved.join("puzzles.db3"),
                )
                .unwrap(),
                "missing" => {}
                _ => unreachable!(),
            }
            assert!(
                matches!(target.probe_current(), Err(Error::Conflict(_))),
                "{replacement} must refuse the retained leaf"
            );
        }
    }

    #[test]
    fn cache_key_conflicts_when_the_path_is_replaced_after_resolve() {
        let fixture = puzzle_deletion_fixture("cache-key-replaced.db3");
        let replacement = fixture.path.with_extension("replacement");
        std::fs::write(&replacement, b"replacement puzzle database").unwrap();
        std::fs::remove_file(&fixture.path).unwrap();
        std::fs::rename(&replacement, &fixture.path).unwrap();
        let error = tauri::async_runtime::block_on(cache_key(
            Arc::clone(&fixture.repository),
            Arc::new(fixture.resolved),
            0,
            u16::MAX,
            None,
            CancellationToken::new(),
        ))
        .expect_err("a replaced puzzle file must not mint a cache key");
        assert!(
            matches!(error, Error::Conflict(_)),
            "unexpected error: {error:?}"
        );
    }

    #[test]
    fn puzzle_cache_key_does_not_create_wal() {
        let fixture = puzzle_deletion_fixture("cache-key-no-wal.db3");
        let wal = fixture.path.with_extension("db3-wal");
        let before = wal.exists();
        let _key = tauri::async_runtime::block_on(cache_key(
            Arc::clone(&fixture.repository),
            Arc::new(fixture.resolved),
            0,
            u16::MAX,
            None,
            CancellationToken::new(),
        ))
        .unwrap();
        assert_eq!(wal.exists(), before, "cache_key must not create a WAL file");
    }

    #[test]
    fn puzzle_cache_key_eq_ignores_database_path() {
        let (_directory, path, repository) = puzzle_database("cache-eq.db3", 1200);
        let database = repository
            .identity_from_probe(
                &crate::db::test_target(&path),
                &CancellationToken::new(),
                false,
            )
            .unwrap();
        let first = PuzzleCacheKey {
            database: database.clone(),
            database_path: path.clone(),
            min_rating: 1000,
            max_rating: 1500,
            theme: None,
        };
        let second = PuzzleCacheKey {
            database,
            database_path: path.with_file_name("other.db3"),
            min_rating: 1000,
            max_rating: 1500,
            theme: None,
        };
        assert_eq!(first, second);
        let mut cache = PuzzleCache::new();
        cache.replace(first, vec![]);
        cache.invalidate_database(Path::new("other.db3"));
        assert!(cache.key.is_some());
        cache.invalidate_database(&path);
        assert!(cache.key.is_none());
    }

    #[test]
    fn puzzle_cache_key_source_is_hydrate_false() {
        let source = include_str!("puzzle.rs");
        let body = source
            .split("async fn cache_key")
            .nth(1)
            .unwrap()
            .split("async fn lock_puzzle_cache_cancellable")
            .next()
            .unwrap();
        assert!(body.contains("identity_from_probe(&target, token, false)"));
        assert!(!body.contains("establish("));
        assert!(!body.contains("database_identity_expected"));
        assert!(!body.contains("Pool::builder"));
    }

    #[cfg(unix)]
    #[test]
    fn command_flow_surfaces_unlink_errors_other_than_not_found() {
        use std::os::unix::fs::PermissionsExt;

        let fixture = puzzle_deletion_fixture("unlink-denied.db3");
        let parent = fixture.path.parent().unwrap().to_owned();
        let original = std::fs::metadata(&parent).unwrap().permissions();
        let mut locked = original.clone();
        locked.set_mode(0o555);
        std::fs::set_permissions(&parent, locked).unwrap();
        let result = tauri::async_runtime::block_on(delete_puzzle_database_resolved(
            fixture.resolved,
            fixture.handle.clone(),
            fixture.repository,
            fixture.authority.clone(),
            Arc::clone(&fixture.cache),
            tokio_util::sync::CancellationToken::new(),
        ));
        std::fs::set_permissions(&parent, original).unwrap();
        result.expect_err("a non-NotFound unlink error must reach the caller");
        assert!(fixture.path.exists());
        assert!(tauri::async_runtime::block_on(fixture.cache.lock())
            .key
            .is_some());
        assert!(authority_contains(&fixture.authority, &fixture.handle));
    }

    #[test]
    fn puzzle_query_rejects_replacement_after_authority_identity_was_captured() {
        let (directory, path, repository) = puzzle_database("original.db3", 1200);
        let expected = crate::infra::path_authority::opened_file_identity(
            &crate::infra::inode_ownership::OwnedFile::open(&path).unwrap(),
        )
        .unwrap();
        let replacement = directory.path().join("replacement.db3");
        let mut replacement_connection = repository
            .schema_specific_connection(&crate::db::test_target(&replacement))
            .unwrap();
        replacement_connection
            .batch_execute(
                "CREATE TABLE puzzles (id INTEGER PRIMARY KEY, fen TEXT NOT NULL, moves TEXT NOT NULL, rating INTEGER NOT NULL, rating_deviation INTEGER NOT NULL, popularity INTEGER NOT NULL, nb_plays INTEGER NOT NULL);\
                 CREATE TABLE themes (id INTEGER PRIMARY KEY, name TEXT NOT NULL);\
                 CREATE TABLE puzzle_themes (puzzle_id INTEGER NOT NULL, theme_id INTEGER NOT NULL);\
                 INSERT INTO puzzles VALUES (1, 'replacement', 'e2e4', 2200, 10, 1, 1);",
            )
            .unwrap();
        drop(replacement_connection);
        repository
            .close_and_invalidate(&crate::db::test_target(&replacement))
            .unwrap();
        std::fs::rename(replacement, &path).unwrap();

        assert!(load_puzzles(
            &repository,
            crate::infra::inode_ownership::OwnedFile::open(&path).unwrap(),
            expected,
            0,
            u16::MAX,
            None,
            &CancellationToken::new(),
        )
        .is_err());
    }

    #[cfg(unix)]
    #[test]
    fn retained_authority_descriptor_queries_original_database_after_path_swap() {
        let (directory, path, repository) = puzzle_database("original.db3", 1200);
        let retained_file = crate::infra::inode_ownership::OwnedFile::open(&path).unwrap();
        let expected = crate::infra::path_authority::opened_file_identity(&retained_file).unwrap();
        let replacement = directory.path().join("replacement.db3");
        let mut replacement_connection = repository
            .schema_specific_connection(&crate::db::test_target(&replacement))
            .unwrap();
        replacement_connection
            .batch_execute(
                "CREATE TABLE puzzles (id INTEGER PRIMARY KEY, fen TEXT NOT NULL, moves TEXT NOT NULL, rating INTEGER NOT NULL, rating_deviation INTEGER NOT NULL, popularity INTEGER NOT NULL, nb_plays INTEGER NOT NULL);\
                 CREATE TABLE themes (id INTEGER PRIMARY KEY, name TEXT NOT NULL);\
                 CREATE TABLE puzzle_themes (puzzle_id INTEGER NOT NULL, theme_id INTEGER NOT NULL);\
                 INSERT INTO puzzles VALUES (1, 'replacement', 'e2e4', 2200, 10, 1, 1);",
            )
            .unwrap();
        drop(replacement_connection);
        repository
            .close_and_invalidate(&crate::db::test_target(&replacement))
            .unwrap();
        std::fs::rename(replacement, &path).unwrap();

        let rows = load_puzzles(
            &repository,
            retained_file,
            expected,
            0,
            u16::MAX,
            None,
            &CancellationToken::new(),
        )
        .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].rating, 1200);
    }

    #[test]
    fn invalid_puzzle_schema_is_reported_as_an_error() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("invalid.db3");
        let repository = DatabaseRepository::default();
        // Opening this creates a valid SQLite file with no puzzle tables.
        drop(
            repository
                .schema_specific_connection(&crate::db::test_target(&path))
                .unwrap(),
        );
        repository
            .close_and_invalidate(&crate::db::test_target(&path))
            .unwrap();
        let object = crate::infra::path_authority::opened_file_identity(
            &crate::infra::inode_ownership::OwnedFile::open(&path).unwrap(),
        )
        .unwrap();
        assert!(load_puzzles(
            &repository,
            crate::infra::inode_ownership::OwnedFile::open(&path).unwrap(),
            object,
            0,
            u16::MAX,
            None,
            &CancellationToken::new(),
        )
        .is_err());
    }

    fn opened_identity(path: &Path) -> (u64, u64) {
        crate::infra::path_authority::opened_file_identity(
            &crate::infra::inode_ownership::OwnedFile::open(path).unwrap(),
        )
        .unwrap()
    }

    fn serialized_payload(error: &Error) -> (String, serde_json::Value) {
        let serialized = serde_json::to_string(error).expect("serialize error");
        let payload = serde_json::from_str(&serialized).expect("serialized error is a JSON object");
        (serialized, payload)
    }

    #[test]
    fn missing_themes_table_is_puzzle_themes_unavailable() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("empty-themes.db3");
        let repository = DatabaseRepository::default();
        drop(
            repository
                .schema_specific_connection(&crate::db::test_target(&path))
                .unwrap(),
        );
        repository
            .close_and_invalidate(&crate::db::test_target(&path))
            .unwrap();
        let object = opened_identity(&path);
        let error = load_puzzle_themes(
            &repository,
            crate::infra::inode_ownership::OwnedFile::open(&path).unwrap(),
            object,
            &CancellationToken::new(),
        )
        .expect_err("empty schema must report missing puzzle themes");
        let (_serialized, payload) = serialized_payload(&error);
        assert_eq!(payload["category"], "puzzle-themes-unavailable");
        assert!(matches!(error, Error::PuzzleThemesUnavailable));
    }

    #[test]
    fn missing_themes_table_is_puzzle_themes_unavailable_for_one_puzzle() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("puzzle-without-themes.db3");
        let repository = DatabaseRepository::default();
        let mut database_connection = repository
            .schema_specific_connection(&crate::db::test_target(&path))
            .unwrap();
        database_connection
            .batch_execute(
                "CREATE TABLE puzzles (id INTEGER PRIMARY KEY, fen TEXT NOT NULL, moves TEXT NOT NULL, rating INTEGER NOT NULL, rating_deviation INTEGER NOT NULL, popularity INTEGER NOT NULL, nb_plays INTEGER NOT NULL);
                 INSERT INTO puzzles VALUES (1, 'fen', 'e2e4', 1200, 10, 1, 1);"
            )
            .unwrap();
        database_connection
            .batch_execute("PRAGMA wal_checkpoint(TRUNCATE);")
            .unwrap();
        drop(database_connection);
        repository
            .close_and_invalidate(&crate::db::test_target(&path))
            .unwrap();
        let object = opened_identity(&path);
        let error = load_themes_for_puzzle(
            &repository,
            crate::infra::inode_ownership::OwnedFile::open(&path).unwrap(),
            object,
            1,
            &CancellationToken::new(),
        )
        .expect_err("puzzles-only schema must report missing puzzle themes");
        let (_serialized, payload) = serialized_payload(&error);
        assert_eq!(payload["category"], "puzzle-themes-unavailable");
        assert!(matches!(error, Error::PuzzleThemesUnavailable));
    }

    #[test]
    fn themes_table_without_name_is_a_database_failure_without_sql() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("themes-without-name.db3");
        let repository = DatabaseRepository::default();
        let mut database_connection = repository
            .schema_specific_connection(&crate::db::test_target(&path))
            .unwrap();
        database_connection
            .batch_execute("CREATE TABLE themes (id INTEGER PRIMARY KEY);")
            .unwrap();
        database_connection
            .batch_execute("PRAGMA wal_checkpoint(TRUNCATE);")
            .unwrap();
        drop(database_connection);
        repository
            .close_and_invalidate(&crate::db::test_target(&path))
            .unwrap();
        let object = opened_identity(&path);
        let error = load_puzzle_themes(
            &repository,
            crate::infra::inode_ownership::OwnedFile::open(&path).unwrap(),
            object,
            &CancellationToken::new(),
        )
        .expect_err("themes without name must stay a diesel failure");
        let (serialized, payload) = serialized_payload(&error);
        assert_eq!(payload["category"], "database");
        assert!(matches!(error, Error::Diesel(_)));
        let source = std::error::Error::source(&error).expect("Diesel keeps its cause");
        let source_text = source.to_string();
        assert!(
            !source_text.contains("no such table"),
            "arm 2 must not be a missing table, got {source_text}"
        );
        assert!(
            !serialized.contains(&source_text),
            "SQL fragment leaked on the wire: {serialized}"
        );
    }

    #[test]
    fn themed_load_puzzles_missing_themes_stays_a_database_failure() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("themed-without-themes.db3");
        let repository = DatabaseRepository::default();
        let mut database_connection = repository
            .schema_specific_connection(&crate::db::test_target(&path))
            .unwrap();
        database_connection
            .batch_execute(
                "CREATE TABLE puzzles (id INTEGER PRIMARY KEY, fen TEXT NOT NULL, moves TEXT NOT NULL, rating INTEGER NOT NULL, rating_deviation INTEGER NOT NULL, popularity INTEGER NOT NULL, nb_plays INTEGER NOT NULL);
                 CREATE TABLE puzzle_themes (puzzle_id INTEGER NOT NULL, theme_id INTEGER NOT NULL);
                 INSERT INTO puzzles VALUES (1, 'fen', 'e2e4', 1200, 10, 1, 1);"
            )
            .unwrap();
        database_connection
            .batch_execute("PRAGMA wal_checkpoint(TRUNCATE);")
            .unwrap();
        drop(database_connection);
        repository
            .close_and_invalidate(&crate::db::test_target(&path))
            .unwrap();
        let object = opened_identity(&path);
        let error = load_puzzles(
            &repository,
            crate::infra::inode_ownership::OwnedFile::open(&path).unwrap(),
            object,
            0,
            u16::MAX,
            Some("fork"),
            &CancellationToken::new(),
        )
        .expect_err("themed load without themes must stay a diesel failure");
        let (serialized, payload) = serialized_payload(&error);
        assert_eq!(payload["category"], "database");
        assert!(matches!(error, Error::Diesel(_)));
        let source = std::error::Error::source(&error).expect("Diesel keeps its cause");
        let source_text = source.to_string();
        assert!(
            source_text.contains("no such table: themes"),
            "arm 3 must see SQLite's missing themes table on source(), got {source_text}"
        );
        assert!(!serialized.contains("no such table: themes"));
    }

    /// The `crate::infra::path_authority::SharedPathAuthority` the workspace helpers take, with `root_path` already
    /// registered as the **active** puzzle root. Its registry lives under `registry_dir`.
    /// Returned rather than asserted here, because one caller needs the handle's `PathRef`.
    fn puzzle_workspace_authority(
        registry_dir: &Path,
        root_path: &Path,
    ) -> (
        crate::infra::path_authority::SharedPathAuthority,
        crate::infra::path_authority::PuzzleRootHandle,
    ) {
        let mut authority = crate::infra::path_authority::PathAuthority::open(
            registry_dir.join("registry.json"),
            vec![],
        )
        .unwrap();
        let root = authority
            .get_or_create_puzzle_root(root_path, "Puzzles", None)
            .unwrap();
        authority.set_active_puzzle_root(&root).unwrap();
        (
            crate::infra::path_authority::SharedPathAuthority::installed(authority),
            root,
        )
    }

    /// The seeding check every case below runs before calling. The guard is taken and dropped
    /// inside this function on purpose: `active_puzzle_root` takes `&mut self` and the call
    /// under test locks the same mutex, so a guard still alive at the call site deadlocks
    /// rather than fails.
    fn assert_active_puzzle_root(
        authority: &crate::infra::path_authority::SharedPathAuthority,
        message: &str,
    ) {
        let mut guard = authority.raw_for_test().lock().unwrap();
        assert!(
            guard
                .as_mut()
                .unwrap()
                .active_puzzle_root()
                .unwrap()
                .is_some(),
            "{message}"
        );
        drop(guard);
    }

    /// The three workspace helpers are generic over `R: tauri::Runtime` so this path is reachable
    /// from `tauri::test::mock_app()` at all. That handle still resolves `app_data_dir()` against
    /// the real user directory, so every case below seeds an **active** puzzle root under a
    /// temporary directory and asserts the seeding took *before* calling: a silently unseeded
    /// authority would otherwise take the default branch and create `<app data>/puzzles` on the
    /// machine running the tests. That assertion is `assert_active_puzzle_root`, which scopes
    /// its guard for the reason recorded there.
    #[test]
    fn puzzle_download_destination_resolves_under_the_active_puzzle_root() {
        let directory = tempfile::tempdir().unwrap();
        let root_path = directory.path().join("puzzles");
        std::fs::create_dir(&root_path).unwrap();
        let (authority, root) = puzzle_workspace_authority(directory.path(), &root_path);
        assert_active_puzzle_root(
            &authority,
            "the seeded puzzle root must be active before the call, or the default branch \
             would register a directory outside the temporary one",
        );

        let app = tauri::test::mock_app();
        let destination =
            issue_puzzle_download_destination_blocking(&authority, app.handle().clone()).unwrap();

        assert_eq!(&destination, root.path_ref());
        let resolved = authority
            .raw_for_test()
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .workspace_root(
                &crate::infra::path_authority::FileWorkspaceHandle::new(destination),
                crate::infra::path_authority::PathOperation::PuzzleRead,
            )
            .unwrap();
        assert_eq!(
            resolved.canonicalize().unwrap(),
            root_path.canonicalize().unwrap()
        );
        assert!(resolved
            .canonicalize()
            .unwrap()
            .starts_with(directory.path().canonicalize().unwrap()));
    }

    /// Returning the root's own `PathRef` is satisfied identically by a body that never asks the
    /// authority, so the equality above does not pin the only work the function does. A puzzle
    /// root carrying `PuzzleRead`/`PuzzleDelete` but not `DownloadFile` activates — activation
    /// gates on `PuzzleRead` alone — and only the `DownloadFile` authorization fails.
    #[test]
    fn puzzle_download_destination_requires_download_authorization() {
        let directory = tempfile::tempdir().unwrap();
        let root_path = directory.path().join("puzzles");
        std::fs::create_dir(&root_path).unwrap();
        let mut authority = crate::infra::path_authority::PathAuthority::open(
            directory.path().join("registry.json"),
            vec![],
        )
        .unwrap();
        let commit = authority
            .migrate_legacy_os_path(
                root_path.as_os_str().to_os_string(),
                "Puzzles",
                crate::infra::path_authority::PathClass::PersistentCustomRoot,
                vec![
                    crate::infra::path_authority::PathOperation::PuzzleRead,
                    crate::infra::path_authority::PathOperation::PuzzleDelete,
                ],
            )
            .unwrap();
        let root = crate::infra::path_authority::PuzzleRootHandle::new(commit.id);
        authority.set_active_puzzle_root(&root).unwrap();
        let authority = crate::infra::path_authority::SharedPathAuthority::installed(authority);
        assert_active_puzzle_root(
            &authority,
            "a root without DownloadFile must still be the active puzzle workspace",
        );

        let app = tauri::test::mock_app();
        let error = issue_puzzle_download_destination_blocking(&authority, app.handle().clone())
            .expect_err("a puzzle root without DownloadFile must not yield a download destination");
        assert!(
            matches!(error, Error::InvalidInput(_)),
            "unexpected error: {error:?}"
        );
    }

    #[test]
    fn list_puzzle_databases_lists_the_children_of_the_active_root() {
        let directory = tempfile::tempdir().unwrap();
        let root_path = directory.path().join("puzzles");
        std::fs::create_dir(&root_path).unwrap();
        std::fs::write(root_path.join("lichess.db3"), b"puzzle database").unwrap();
        std::fs::write(root_path.join("notes.txt"), b"not a puzzle database").unwrap();
        let (authority, _root) = puzzle_workspace_authority(directory.path(), &root_path);
        assert_active_puzzle_root(
            &authority,
            "the seeded puzzle root must be active before the call, or the default branch \
             would list a directory outside the temporary one",
        );

        let app = tauri::test::mock_app();
        let databases =
            list_puzzle_databases_blocking(app.handle(), &authority, &CancellationToken::new())
                .unwrap();

        let filenames: Vec<_> = databases
            .iter()
            .map(|database| database.filename.as_str())
            .collect();
        assert_eq!(filenames, ["lichess.db3"]);
    }

    #[test]
    #[cfg(unix)]
    fn root_failure_puzzle_read_loss_and_probe_cancellation_preserve_original() {
        use crate::infra::path_authority::{
            ListingRootFailureHookGuard, TestRootPermissionGuard, LISTING_ROOT_FAILURE_HOOKS,
        };
        if unsafe { libc::geteuid() } == 0 {
            return;
        }
        for cancel in [false, true] {
            let directory = tempfile::tempdir().unwrap();
            let root_path = directory.path().join("puzzles");
            std::fs::create_dir(&root_path).unwrap();
            std::fs::write(root_path.join("child.db3"), b"puzzle").unwrap();
            let (authority, root) = puzzle_workspace_authority(directory.path(), &root_path);
            assert_active_puzzle_root(&authority, "selected puzzle root must exist");
            let before = std::fs::read(directory.path().join("registry.json")).unwrap();
            let cancellation = CancellationToken::new();
            let hook_cancellation = cancellation.clone();
            let observed = Arc::new(std::sync::Mutex::new(None));
            let hook_observed = observed.clone();
            let _hook = ListingRootFailureHookGuard(root.path_ref().id.clone());
            LISTING_ROOT_FAILURE_HOOKS.arm(
                root.path_ref().id.clone(),
                Box::new(move |error| {
                    *hook_observed.lock().unwrap() =
                        Some((error.category(), error.to_string(), error.diagnostic()));
                    if cancel {
                        hook_cancellation.cancel();
                    }
                }),
            );
            let permissions = TestRootPermissionGuard::restrict(&root_path, 0o300);
            let app = tauri::test::mock_app();
            let result = list_puzzle_databases_blocking(app.handle(), &authority, &cancellation);
            drop(permissions);
            let error = result.unwrap_err();
            let original = observed
                .lock()
                .unwrap()
                .take()
                .expect("actual failed listing must reach probe");
            if cancel {
                assert!(matches!(error, Error::Cancellation));
                assert_eq!(error.root_failure(), None);
            } else {
                assert_eq!(
                    error.root_failure(),
                    Some(crate::error::RootFailure::Permission),
                    "{error:?}"
                );
                assert_eq!(
                    (error.category(), error.to_string(), error.diagnostic()),
                    original
                );
            }
            assert_eq!(
                std::fs::read(directory.path().join("registry.json")).unwrap(),
                before
            );
            assert_eq!(
                list_puzzle_databases_blocking(app.handle(), &authority, &CancellationToken::new())
                    .unwrap()
                    .len(),
                1
            );
        }
    }

    #[test]
    #[cfg(unix)]
    fn root_failure_puzzle_healthy_root_keeps_replaced_child_error() {
        use crate::infra::path_authority::{
            set_puzzle_child_post_resolve_hook, ListingRootFailureHookGuard,
            LISTING_ROOT_FAILURE_HOOKS,
        };
        let directory = tempfile::tempdir().unwrap();
        let root_path = directory.path().join("puzzles");
        std::fs::create_dir(&root_path).unwrap();
        let child = root_path.join("child.db3");
        std::fs::write(&child, b"puzzle").unwrap();
        let (authority, root) = puzzle_workspace_authority(directory.path(), &root_path);
        assert_active_puzzle_root(&authority, "selected puzzle root must exist");
        let saved = directory.path().join("original.db3");
        set_puzzle_child_post_resolve_hook(Some(Box::new(move || {
            std::fs::rename(&child, saved).unwrap();
            std::fs::write(&child, b"replacement").unwrap();
        })));
        let observed = Arc::new(std::sync::Mutex::new(None));
        let hook_observed = observed.clone();
        let _hook = ListingRootFailureHookGuard(root.path_ref().id.clone());
        LISTING_ROOT_FAILURE_HOOKS.arm(
            root.path_ref().id.clone(),
            Box::new(move |error| {
                *hook_observed.lock().unwrap() =
                    Some((error.category(), error.to_string(), error.diagnostic()));
            }),
        );
        let app = tauri::test::mock_app();
        let error =
            list_puzzle_databases_blocking(app.handle(), &authority, &CancellationToken::new())
                .unwrap_err();
        set_puzzle_child_post_resolve_hook(None);
        assert_eq!(error.root_failure(), None);
        assert_eq!(error.category(), crate::error::ErrorCategory::Conflict);
        assert_eq!(
            (error.category(), error.to_string(), error.diagnostic()),
            observed.lock().unwrap().take().unwrap()
        );
    }

    #[test]
    fn puzzle_workspace_without_an_authority_is_a_conflict() {
        let authority = crate::infra::path_authority::SharedPathAuthority::uninitialized();
        let app = tauri::test::mock_app();
        let error =
            list_puzzle_databases_blocking(app.handle(), &authority, &CancellationToken::new())
                .expect_err("an uninitialized authority must not reach the filesystem");
        assert!(
            matches!(error, Error::Conflict(ref message) if message == "path authority is not initialized"),
            "unexpected error: {error:?}"
        );
        assert_eq!(error.root_failure(), None);
    }
}
