//! Specta IPC commands for Studio Library sync (S-6).

use crate::{
    infra::path_authority::FileWorkspaceHandle,
    library_sync::{
        LibrarySyncError, LibrarySyncOwner, LibrarySyncSnapshot, LibrarySyncTurnOffMode,
    },
    AppState,
};

fn sync_owner(state: &AppState) -> Result<&LibrarySyncOwner, LibrarySyncError> {
    state
        .library_sync
        .get()
        .ok_or(LibrarySyncError::Unavailable)
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn library_sync_snapshot(
    state: tauri::State<'_, AppState>,
    workspace: FileWorkspaceHandle,
) -> Result<LibrarySyncSnapshot, LibrarySyncError> {
    sync_owner(&state)?.snapshot(workspace).await
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn library_sync_turn_on(
    state: tauri::State<'_, AppState>,
    workspace: FileWorkspaceHandle,
    deselected: Vec<FileWorkspaceHandle>,
) -> Result<LibrarySyncSnapshot, LibrarySyncError> {
    sync_owner(&state)?.turn_on(workspace, deselected).await
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn library_sync_turn_off(
    state: tauri::State<'_, AppState>,
    workspace: FileWorkspaceHandle,
    mode: LibrarySyncTurnOffMode,
) -> Result<LibrarySyncSnapshot, LibrarySyncError> {
    sync_owner(&state)?.turn_off(workspace, mode).await
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn library_sync_set_file_selected(
    state: tauri::State<'_, AppState>,
    workspace: FileWorkspaceHandle,
    file: FileWorkspaceHandle,
    selected: bool,
) -> Result<LibrarySyncSnapshot, LibrarySyncError> {
    sync_owner(&state)?
        .set_file_selected(workspace, file, selected)
        .await
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn library_sync_now(
    state: tauri::State<'_, AppState>,
    workspace: FileWorkspaceHandle,
) -> Result<LibrarySyncSnapshot, LibrarySyncError> {
    sync_owner(&state)?.sync_now(workspace).await
}
