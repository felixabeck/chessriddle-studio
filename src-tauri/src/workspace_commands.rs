#[cfg(test)]
use std::sync::{Arc, Barrier, Mutex, OnceLock};
use std::{ffi::OsStr, io::Write, path::PathBuf};

use tauri::{Manager, WebviewWindow};

use crate::chessbase;
use crate::error::Error;
use crate::file_workspace::{map_picker_join, open_resolved_folder, seed_folder_picker};
use crate::infra::blocking::BLOCKING_GATEWAY;
use crate::infra::operations::OperationRegistry;
use crate::{native_read_operation, AppState};

const MAX_ENGINE_IMAGE_BYTES: usize = 10 * 1024 * 1024;

#[cfg(test)]
pub(crate) struct ImageIssuanceTestGate {
    pub(crate) entered: Arc<Barrier>,
    pub(crate) release: Arc<Barrier>,
}
#[cfg(test)]
pub(crate) static IMAGE_ISSUANCE_TEST_GATE: OnceLock<Mutex<Option<ImageIssuanceTestGate>>> =
    OnceLock::new();

#[cfg(test)]
fn pause_image_issuance_after_lease() {
    let gate = IMAGE_ISSUANCE_TEST_GATE
        .get_or_init(|| Mutex::new(None))
        .lock()
        .expect("image issuance test gate")
        .take();
    if let Some(gate) = gate {
        gate.entered.wait();
        gate.release.wait();
    }
}

#[tauri::command]
#[specta::specta]
pub async fn issue_pgn_workspace(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<crate::infra::path_authority::FileWorkspaceDescriptor, Error> {
    use tauri_plugin_dialog::DialogExt;
    let path = tokio::task::spawn_blocking(move || {
        let extensions = chessbase::picker_extensions();
        let filters: Vec<&str> = extensions.iter().map(String::as_str).collect();
        app.dialog()
            .file()
            .add_filter("PGN, ChessBase", &filters)
            .blocking_pick_file()
            .ok_or(Error::Cancellation)?
            .into_path()
            .map_err(|error| Error::native_selection("invalid native file selection", error))
    })
    .await
    .map_err(map_picker_join)??;
    let authority = state.pgn_path_authority.clone();
    crate::infra::operations::run_accepted_blocking(
        &state.operations,
        "issue_pgn_workspace",
        move || issue_pgn_workspace_blocking(&authority, path),
    )
    .await
}

pub(crate) fn issue_pgn_workspace_blocking(
    authority: &crate::infra::path_authority::SharedPathAuthority,
    path: PathBuf,
) -> Result<crate::infra::path_authority::FileWorkspaceDescriptor, Error> {
    if chessbase::is_database(&path) {
        return Err(Error::ChessBaseDatabase);
    }
    let display_name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "PGN".into());
    authority.with_mut(|authority| {
        let grant = authority.grant_dialog_operations(
            &path,
            display_name.clone(),
            crate::infra::path_authority::PathClass::BoundedDialogGrant,
            vec![
                crate::infra::path_authority::PathOperation::ReadPgn,
                crate::infra::path_authority::PathOperation::WritePgn,
            ],
            crate::infra::path_authority::PGN_FILE_DIALOG_GRANT_TTL,
            crate::infra::path_authority::PGN_FILE_DIALOG_GRANT_USES,
        )?;
        let commit = authority.promote_dialog(
            &grant,
            crate::infra::path_authority::PathClass::PersistentFile,
            display_name.clone(),
            vec![
                crate::infra::path_authority::PathOperation::ReadPgn,
                crate::infra::path_authority::PathOperation::WritePgn,
            ],
        )?;
        Ok(crate::infra::path_authority::FileWorkspaceDescriptor {
            handle: crate::infra::path_authority::FileWorkspaceHandle::new(commit.id),
            display_name,
            availability: crate::infra::path_authority::PathAvailability::Available,
        })
    })?
}

/// Native-only save destination picker for database export. The selection is immediately
/// persisted as an exact ReadPgn+WritePgn workspace, so the renderer never receives a path and
/// can safely open the exported file after writing it.
#[tauri::command]
#[specta::specta]
pub async fn issue_pgn_export_destination(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<crate::infra::path_authority::FileWorkspaceDescriptor, Error> {
    use tauri_plugin_dialog::DialogExt;
    let path = tokio::task::spawn_blocking(move || {
        app.dialog()
            .file()
            .add_filter("PGN", &["pgn"])
            .set_file_name("games.pgn")
            .blocking_save_file()
            .ok_or(Error::Cancellation)?
            .into_path()
            .map_err(|error| Error::native_selection("invalid native file selection", error))
    })
    .await
    .map_err(map_picker_join)??;
    let authority = state.pgn_path_authority.clone();
    crate::infra::operations::run_accepted_blocking(
        &state.operations,
        "issue_pgn_export_destination",
        move || issue_pgn_export_destination_blocking(&authority, path),
    )
    .await
}

fn issue_pgn_export_destination_blocking(
    authority: &crate::infra::path_authority::SharedPathAuthority,
    path: PathBuf,
) -> Result<crate::infra::path_authority::FileWorkspaceDescriptor, Error> {
    let display_name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "PGN export".into());
    authority.with_mut(|authority| authority.create_pgn_export_destination(&path, display_name))?
}

async fn save_native_export(
    app: &tauri::AppHandle,
    operations: &OperationRegistry,
    label: &'static str,
    suggested_name: &str,
    extension: &str,
    bytes: &[u8],
) -> Result<(), Error> {
    use tauri_plugin_dialog::DialogExt;
    let picker_app = app.clone();
    let picker_extension = extension.to_owned();
    let picker_name = suggested_name.to_owned();
    let path = tokio::task::spawn_blocking(move || {
        picker_app
            .dialog()
            .file()
            .add_filter(
                picker_extension.to_uppercase(),
                &[picker_extension.as_str()],
            )
            .set_file_name(picker_name)
            .blocking_save_file()
            .ok_or(Error::Cancellation)?
            .into_path()
            .map_err(|error| Error::native_selection("invalid native file selection", error))
    })
    .await
    .map_err(map_picker_join)??;
    let extension = extension.to_owned();
    let bytes = bytes.to_vec();
    crate::infra::operations::run_accepted_blocking(operations, label, move || {
        save_native_export_blocking(path, extension, bytes)
    })
    .await
}

fn save_native_export_blocking(
    path: PathBuf,
    extension: String,
    bytes: Vec<u8>,
) -> Result<(), Error> {
    let dest = crate::infra::fs::NativeExportDest::from_save_path(path, &extension)?;
    let outcome = dest.replace(|file| {
        file.write_all(&bytes).map_err(Error::from)?;
        Ok(())
    })?;
    crate::infra::fs::require_durable(outcome, crate::error::DurabilityStage::NativeExport)
}

/// Native save dialog and atomic export for a renderer-produced board image.
#[tauri::command]
#[specta::specta]
pub async fn save_board_snapshot(app: tauri::AppHandle, bytes: Vec<u8>) -> Result<(), Error> {
    save_native_export(
        &app,
        &app.state::<AppState>().operations,
        "save_board_snapshot",
        "board.png",
        "png",
        &bytes,
    )
    .await
}

/// Native save dialog and atomic export for renderer-selected engine logs.
#[tauri::command]
#[specta::specta]
pub async fn save_engine_logs(app: tauri::AppHandle, text: String) -> Result<(), Error> {
    save_native_export(
        &app,
        &app.state::<AppState>().operations,
        "save_engine_logs",
        "engine-logs.csv",
        "csv",
        text.as_bytes(),
    )
    .await
}

/// The native picker creates a persistent, least-privilege root for one-file downloads.
/// The renderer receives only the opaque capability ID, never a filesystem path.
#[tauri::command]
#[specta::specta]
pub async fn issue_download_destination(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<crate::infra::path_authority::PathRef, Error> {
    use tauri_plugin_dialog::DialogExt;
    let path = tokio::task::spawn_blocking(move || {
        app.dialog()
            .file()
            .blocking_pick_folder()
            .ok_or(Error::Cancellation)?
            .into_path()
            .map_err(|error| Error::native_selection("invalid native folder selection", error))
    })
    .await
    .map_err(map_picker_join)??;
    let authority = state.pgn_path_authority.clone();
    crate::infra::operations::run_accepted_blocking(
        &state.operations,
        "issue_download_destination",
        move || issue_download_destination_blocking(&authority, path),
    )
    .await
}

fn issue_download_destination_blocking(
    authority: &crate::infra::path_authority::SharedPathAuthority,
    path: PathBuf,
) -> Result<crate::infra::path_authority::PathRef, Error> {
    let display_name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Download destination".into());
    authority.with_mut(|authority| {
        let grant = authority.grant_dialog(
            &path,
            display_name.clone(),
            crate::infra::path_authority::PathClass::SingleDialogGrant,
            crate::infra::path_authority::PathOperation::DownloadFile,
            crate::infra::path_authority::PICKER_DIALOG_GRANT_TTL,
            1,
        )?;
        Ok(authority
            .promote_dialog(
                &grant,
                crate::infra::path_authority::PathClass::PersistentCustomRoot,
                display_name,
                vec![crate::infra::path_authority::PathOperation::DownloadFile],
            )?
            .id)
    })?
}

#[tauri::command]
#[specta::specta]
pub async fn download_destination_is_known(
    destination: crate::infra::path_authority::PathRef,
    state: tauri::State<'_, AppState>,
) -> Result<bool, Error> {
    let authority = state.pgn_path_authority.clone();
    crate::infra::operations::run_accepted_blocking(
        &state.operations,
        "download_destination_is_known",
        move || download_destination_is_known_blocking(&authority, destination),
    )
    .await
}

fn download_destination_is_known_blocking(
    authority: &crate::infra::path_authority::SharedPathAuthority,
    destination: crate::infra::path_authority::PathRef,
) -> Result<bool, Error> {
    authority.with_mut(|authority| Ok(authority.download_destination_is_known(&destination)))?
}

/// Native-only database-root selection.  A directory is promoted immediately
/// to a persistent database workspace and the renderer receives its opaque
/// handle and the folder's display name, never its path.
#[tauri::command]
#[specta::specta]
pub async fn issue_database_workspace(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<crate::infra::path_authority::DatabaseRootDescriptor, Error> {
    let authority = state.pgn_path_authority.clone();
    let picker_authority = authority.clone();
    let path = tokio::task::spawn_blocking(move || {
        use tauri_plugin_dialog::DialogExt;
        seed_folder_picker(
            app.dialog().file(),
            &picker_authority,
            &app,
            |authority, lookup| authority.database_folder_open_path(lookup).ok(),
        )
        .blocking_pick_folder()
        .ok_or(Error::Cancellation)?
        .into_path()
        .map_err(|error| Error::native_selection("invalid database folder selection", error))
    })
    .await
    .map_err(map_picker_join)??;
    crate::infra::operations::run_accepted_blocking(
        &state.operations,
        "issue_database_workspace",
        move || issue_database_workspace_blocking(&authority, path),
    )
    .await
}

fn issue_database_workspace_blocking(
    authority: &crate::infra::path_authority::SharedPathAuthority,
    path: PathBuf,
) -> Result<crate::infra::path_authority::DatabaseRootDescriptor, Error> {
    let display_name = crate::infra::path_authority::selected_root_display_name(&path, "Databases");
    authority.with_mut(|authority| {
        let root = authority.get_or_create_database_root(&path, display_name, None)?;
        authority.set_active_database_root(&root)?;
        authority.database_root_descriptor(root)
    })?
}

/// Returns the active database root or refuses an unusable selection. With no selection,
/// it acquires, registers and activates the app-owned default root without a renderer path.
#[tauri::command]
#[specta::specta]
pub async fn get_database_workspace(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<crate::infra::path_authority::DatabaseRootDescriptor, Error> {
    let authority = state.pgn_path_authority.clone();
    crate::infra::operations::run_accepted_blocking(
        &state.operations,
        "get_database_workspace",
        move || {
            get_database_workspace_blocking(&authority, &|| {
                crate::infra::path_authority::AppDataDir::for_app(&app)
            })
        },
    )
    .await
}

fn get_database_workspace_blocking(
    authority: &crate::infra::path_authority::SharedPathAuthority,
    app_data: &dyn Fn() -> Result<crate::infra::path_authority::AppDataDir, Error>,
) -> Result<crate::infra::path_authority::DatabaseRootDescriptor, Error> {
    authority.with_mut(|authority| {
        if let Some(root) = authority.active_database_root()? {
            return authority.database_root_descriptor(root);
        }
        let app_data = app_data()?;
        let root = get_default_database_workspace(authority, &app_data)?;
        authority.database_root_descriptor(root)
    })?
}

pub(crate) fn get_default_database_workspace(
    authority: &mut crate::infra::path_authority::PathAuthority,
    app_data: &crate::infra::path_authority::AppDataDir,
) -> Result<crate::infra::path_authority::DatabaseRootHandle, Error> {
    let authorized_dir = crate::infra::path_authority::ensure_app_owned_default_dir(
        app_data,
        crate::infra::path_authority::AppOwnedDefaultRoot::Databases,
    )
    .map_err(Error::label_root_failure)?;
    let root = authority.get_or_create_database_root(
        authorized_dir.path(),
        "Databases",
        Some(authorized_dir.identity()),
    )?;
    authority.set_active_default_database_root(&root)?;
    Ok(root)
}

#[tauri::command]
#[specta::specta]
pub async fn list_workspace_databases(
    root: crate::infra::path_authority::DatabaseRootHandle,
    ticket: Option<String>,
    window: WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> Result<crate::infra::path_authority::DatabaseListing, Error> {
    let operation = native_read_operation(ticket, &window, &state, "list_workspace_databases")?;
    let cancellation = operation.token();
    let authority = state.pgn_path_authority.clone();
    crate::infra::operations::run_native_operation(
        operation,
        "list_workspace_databases",
        async move {
            BLOCKING_GATEWAY
                .spawn_cancellable(cancellation, move |token| {
                    if token.is_cancelled() {
                        return Err(Error::Cancellation);
                    }
                    let databases = list_workspace_databases_blocking(&authority, root, token)?;
                    if token.is_cancelled() {
                        return Err(Error::Cancellation);
                    }
                    Ok(databases)
                })
                .await
        },
    )
    .await
}

pub(crate) fn list_workspace_databases_blocking(
    authority: &crate::infra::path_authority::SharedPathAuthority,
    root: crate::infra::path_authority::DatabaseRootHandle,
    cancellation: &tokio_util::sync::CancellationToken,
) -> Result<crate::infra::path_authority::DatabaseListing, Error> {
    let result = (|| {
        authority.with_mut(|authority| {
            authority.list_database_children_cancellable(&root, cancellation)
        })?
    })();
    result.map_err(|error| {
        crate::infra::path_authority::probe_listing_root_failure(
            authority,
            root.path_ref(),
            crate::infra::path_authority::PathOperation::DatabaseRead,
            error,
            cancellation,
        )
    })
}

#[tauri::command]
#[specta::specta]
pub async fn create_workspace_database(
    root: crate::infra::path_authority::DatabaseRootHandle,
    filename: String,
    state: tauri::State<'_, AppState>,
) -> Result<crate::infra::path_authority::DatabaseHandle, Error> {
    let authority = state.pgn_path_authority.clone();
    crate::infra::operations::run_accepted_blocking(
        &state.operations,
        "create_workspace_database",
        move || create_workspace_database_blocking(&authority, root, filename),
    )
    .await
}

pub(crate) fn create_workspace_database_blocking(
    authority: &crate::infra::path_authority::SharedPathAuthority,
    root: crate::infra::path_authority::DatabaseRootHandle,
    filename: String,
) -> Result<crate::infra::path_authority::DatabaseHandle, Error> {
    if filename.is_empty() || filename.contains('/') || filename.contains('\\') {
        return Err(Error::InvalidInput("invalid database filename".into()));
    }
    authority.with_mut(|authority| {
        authority.create_database_child(&root, std::ffi::OsStr::new(&filename))
    })?
}

#[tauri::command]
#[specta::specta]
pub async fn database_download_destination(
    root: crate::infra::path_authority::DatabaseRootHandle,
    state: tauri::State<'_, AppState>,
) -> Result<crate::infra::path_authority::PathRef, Error> {
    let authority = state.pgn_path_authority.clone();
    crate::infra::operations::run_accepted_blocking(
        &state.operations,
        "database_download_destination",
        move || database_download_destination_blocking(&authority, root),
    )
    .await
}

fn database_download_destination_blocking(
    authority: &crate::infra::path_authority::SharedPathAuthority,
    root: crate::infra::path_authority::DatabaseRootHandle,
) -> Result<crate::infra::path_authority::PathRef, Error> {
    authority.with_mut(|authority| authority.database_download_destination(&root))?
}

#[tauri::command]
#[specta::specta]
pub async fn issue_engine_workspace(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<crate::infra::path_authority::EngineRootDescriptor, Error> {
    let authority = state.pgn_path_authority.clone();
    let picker_authority = authority.clone();
    let path = tokio::task::spawn_blocking(move || {
        use tauri_plugin_dialog::DialogExt;
        seed_folder_picker(
            app.dialog().file(),
            &picker_authority,
            &app,
            |authority, lookup| authority.engine_folder_open_path(lookup).ok(),
        )
        .blocking_pick_folder()
        .ok_or(Error::Cancellation)?
        .into_path()
        .map_err(|error| Error::native_selection("invalid engine folder selection", error))
    })
    .await
    .map_err(map_picker_join)??;
    crate::infra::operations::run_accepted_blocking(
        &state.operations,
        "issue_engine_workspace",
        move || issue_engine_workspace_blocking(&authority, path),
    )
    .await
}

fn issue_engine_workspace_blocking(
    authority: &crate::infra::path_authority::SharedPathAuthority,
    path: PathBuf,
) -> Result<crate::infra::path_authority::EngineRootDescriptor, Error> {
    let display_name = crate::infra::path_authority::selected_root_display_name(&path, "Engines");
    authority.with_mut(|authority| {
        let root = authority.get_or_create_engine_root(&path, display_name, None)?;
        authority.set_active_engine_root(&root)?;
        authority.engine_root_descriptor(root)
    })?
}

/// Returns the active engine root or refuses an unusable selection. The app-owned default
/// is created and activated only when no selection exists.
#[tauri::command]
#[specta::specta]
pub async fn get_engine_workspace(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<crate::infra::path_authority::EngineRootDescriptor, Error> {
    let authority = state.pgn_path_authority.clone();
    crate::infra::operations::run_accepted_blocking(
        &state.operations,
        "get_engine_workspace",
        move || {
            get_engine_workspace_blocking(&authority, &|| {
                crate::infra::path_authority::AppDataDir::for_app(&app)
            })
        },
    )
    .await
}

fn get_engine_workspace_blocking(
    authority: &crate::infra::path_authority::SharedPathAuthority,
    app_data: &dyn Fn() -> Result<crate::infra::path_authority::AppDataDir, Error>,
) -> Result<crate::infra::path_authority::EngineRootDescriptor, Error> {
    authority.with_mut(|authority| {
        if let Some(root) = authority.active_engine_root()? {
            return authority.engine_root_descriptor(root);
        }
        let authorized_dir = crate::infra::path_authority::ensure_app_owned_default_dir(
            &app_data()?,
            crate::infra::path_authority::AppOwnedDefaultRoot::Engines,
        )?;
        let root = authority.get_or_create_engine_root(
            authorized_dir.path(),
            "Engines",
            Some(authorized_dir.identity()),
        )?;
        authority.set_active_engine_root(&root)?;
        authority.engine_root_descriptor(root)
    })?
}

#[tauri::command]
#[specta::specta]
pub async fn issue_engine_binary(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<crate::infra::path_authority::EngineHandle, Error> {
    use tauri_plugin_dialog::DialogExt;
    let path = tokio::task::spawn_blocking(move || {
        app.dialog()
            .file()
            .blocking_pick_file()
            .ok_or(Error::Cancellation)?
            .into_path()
            .map_err(|error| Error::native_selection("invalid engine file selection", error))
    })
    .await
    .map_err(map_picker_join)??;
    let authority = state.pgn_path_authority.clone();
    crate::infra::operations::run_accepted_blocking(
        &state.operations,
        "issue_engine_binary",
        move || issue_engine_binary_blocking(&authority, path),
    )
    .await
}

fn issue_engine_binary_blocking(
    authority: &crate::infra::path_authority::SharedPathAuthority,
    path: PathBuf,
) -> Result<crate::infra::path_authority::EngineHandle, Error> {
    let label = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Engine".into());
    authority.with_mut(|authority| authority.register_engine_file(&path, label))?
}

/// Native-only resource picker for UCI file/directory options.  The dialog
/// selection is immediately bound to a no-follow persistent capability.
#[tauri::command]
#[specta::specta]
pub async fn issue_engine_resource(
    directory: bool,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<crate::infra::path_authority::EngineResourceHandle, Error> {
    use tauri_plugin_dialog::DialogExt;
    let path = tokio::task::spawn_blocking(move || {
        let picker = app.dialog().file();
        let selected = if directory {
            picker.blocking_pick_folder()
        } else {
            picker.blocking_pick_file()
        };
        selected
            .ok_or(Error::Cancellation)?
            .into_path()
            .map_err(|error| Error::native_selection("invalid engine resource selection", error))
    })
    .await
    .map_err(map_picker_join)??;
    let authority = state.pgn_path_authority.clone();
    crate::infra::operations::run_accepted_blocking(
        &state.operations,
        "issue_engine_resource",
        move || issue_engine_resource_blocking(&authority, path, directory),
    )
    .await
}

fn issue_engine_resource_blocking(
    authority: &crate::infra::path_authority::SharedPathAuthority,
    path: PathBuf,
    directory: bool,
) -> Result<crate::infra::path_authority::EngineResourceHandle, Error> {
    let label = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Engine resource".into());
    authority.with_mut(|authority| {
        let grant = authority.grant_dialog(
            &path,
            label.clone(),
            crate::infra::path_authority::PathClass::SingleDialogGrant,
            crate::infra::path_authority::PathOperation::EngineResourceRead,
            crate::infra::path_authority::PICKER_DIALOG_GRANT_TTL,
            1,
        )?;
        authority.promote_engine_resource(
            &grant,
            if directory {
                crate::infra::path_authority::EngineResourceHandleKind::Directory
            } else {
                crate::infra::path_authority::EngineResourceHandleKind::File
            },
            label,
        )
    })?
}

#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct EngineImageData {
    bytes: Vec<u8>,
    mime_type: String,
}

fn engine_image_mime_type(bytes: &[u8]) -> Result<&'static str, Error> {
    use crate::infra::validation::{detect_allowed_raster_format, RasterFormat};
    detect_allowed_raster_format(
        bytes,
        &[
            RasterFormat::Png,
            RasterFormat::Jpeg,
            RasterFormat::Gif,
            RasterFormat::Webp,
        ],
    )
    .map(RasterFormat::mime_type)
    .ok_or_else(|| {
        Error::InvalidInput("engine image must be a PNG, JPEG, GIF, or WebP file".into())
    })
}

/// Copies a picker-selected raster image into app-owned storage. The original
/// physical path is consumed natively and never serialized to the renderer.
#[tauri::command]
#[specta::specta]
pub async fn issue_engine_image(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<crate::infra::path_authority::EngineImageHandle, Error> {
    use tauri_plugin_dialog::DialogExt;
    let picker_app = app.clone();
    let path = tokio::task::spawn_blocking(move || {
        picker_app
            .dialog()
            .file()
            .add_filter("Image", &["png", "jpg", "jpeg", "gif", "webp"])
            .blocking_pick_file()
            .ok_or(Error::Cancellation)?
            .into_path()
            .map_err(|error| Error::native_selection("invalid native image selection", error))
    })
    .await
    .map_err(map_picker_join)??;
    let authority = state.pgn_path_authority.clone();
    let operation = state.operations.accept("issue_engine_image")?;
    crate::infra::operations::run_native_operation(operation, "issue_engine_image", async move {
        issue_engine_image_blocking_async(authority, app, path, None).await
    })
    .await
}

fn issue_engine_image_blocking<R: tauri::Runtime>(
    authority: &crate::infra::path_authority::SharedPathAuthority,
    app: tauri::AppHandle<R>,
    path: PathBuf,
    app_data_override: Option<crate::infra::path_authority::AppDataDir>,
) -> Result<crate::infra::path_authority::EngineImageHandle, Error> {
    let display_name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Engine image".into());
    let (issuance_lease, grant) = {
        authority.with_mut(|authority| {
            let issuance_lease = authority.begin_engine_image_issuance()?;
            let grant = authority.grant_dialog(
                &path,
                display_name.clone(),
                crate::infra::path_authority::PathClass::SingleDialogGrant,
                crate::infra::path_authority::PathOperation::ImageRead,
                crate::infra::path_authority::PICKER_DIALOG_GRANT_TTL,
                1,
            )?;
            Ok::<_, Error>((issuance_lease, grant))
        })??
    };
    // The lease intentionally spans descriptor reads, the complete blocking copy, registration,
    // and error cleanup. A dropped command future cannot let shutdown unlink this image early.
    let _issuance_lease = issuance_lease;
    #[cfg(test)]
    pause_image_issuance_after_lease();
    let app_data = app_data_override
        .map(Ok)
        .unwrap_or_else(|| crate::infra::path_authority::AppDataDir::for_app(&app))?;
    let (file, declared) = crate::infra::path_authority::engine_image_reader_for(
        authority,
        &crate::infra::path_authority::EngineImageHandle::new(grant),
        MAX_ENGINE_IMAGE_BYTES,
    )?;
    let bytes = crate::infra::path_authority::read_engine_image_bytes(
        file,
        declared,
        MAX_ENGINE_IMAGE_BYTES,
    )?;
    engine_image_mime_type(&bytes)?;
    let image_dir = crate::infra::path_authority::ensure_app_owned_default_dir(
        &app_data,
        crate::infra::path_authority::AppOwnedDefaultRoot::EngineImages,
    )?;
    let leaf_name = uuid::Uuid::new_v4().to_string();
    let leaf = OsStr::new(&leaf_name);
    let (outcome, installed) = image_dir
        .atomic_replace_leaf_identified(leaf, |file| file.write_all(&bytes).map_err(Error::from))?;
    match outcome {
        crate::infra::fs::AtomicFileOutcome::DurableCommit => {}
        crate::infra::fs::AtomicFileOutcome::CommittedDurabilityUncertain(error) => {
            log::warn!(
                "engine-image parent sync failed after installing {leaf_name:?}; the leaf is kept: {error}"
            );
        }
    }
    match authority.with_mut(|authority| {
        match authority.register_engine_image(&image_dir, leaf, installed, display_name) {
            Ok(handle) => Ok(handle),
            Err(error) => Err(engine_image_error_after_cleanup(
                &image_dir,
                leaf,
                installed,
                error,
                Some(authority),
            )),
        }
    }) {
        Ok(result) => result,
        Err(unavailable) => Err(engine_image_error_after_cleanup(
            &image_dir,
            leaf,
            installed,
            Error::from(unavailable),
            None,
        )),
    }
}

pub(crate) async fn issue_engine_image_blocking_async<R: tauri::Runtime>(
    authority: crate::infra::path_authority::SharedPathAuthority,
    app: tauri::AppHandle<R>,
    path: PathBuf,
    app_data_override: Option<crate::infra::path_authority::AppDataDir>,
) -> Result<crate::infra::path_authority::EngineImageHandle, Error> {
    BLOCKING_GATEWAY
        .spawn(move || issue_engine_image_blocking(&authority, app, path, app_data_override))
        .await
}

fn engine_image_error_after_cleanup(
    image_dir: &crate::infra::path_authority::AuthorizedDir,
    leaf: &OsStr,
    installed: crate::infra::path_authority::VerifiedIdentity,
    original: Error,
    authority: Option<&mut crate::infra::path_authority::PathAuthority>,
) -> Error {
    match image_dir.remove_leaf_identified(leaf, installed) {
        Ok(()) => original,
        Err(error) if error.is_missing_entry() => original,
        Err(Error::CommittedDurabilityUncertain(stage)) => {
            log::warn!("engine image {leaf:?} was removed but parent sync is uncertain at {stage}");
            original
        }
        Err(removal) => {
            let intent = authority.map_or_else(
                || "not recorded: no path authority".into(),
                |authority| {
                    authority
                        .record_engine_image_cleanup(image_dir, leaf, installed)
                        .diagnostic()
                },
            );
            Error::with_cleanup(
                original,
                Err(Error::Conflict(format!(
                    "failed to remove unregistered engine image {leaf:?}: {}; cleanup intent {intent}",
                    removal.diagnostic()
                ))),
            )
        }
    }
}

#[tauri::command]
#[specta::specta]
pub async fn read_engine_image(
    image: crate::infra::path_authority::EngineImageHandle,
    state: tauri::State<'_, AppState>,
) -> Result<EngineImageData, Error> {
    let authority = state.pgn_path_authority.clone();
    crate::infra::operations::run_accepted_blocking(
        &state.operations,
        "read_engine_image",
        move || read_engine_image_blocking(&authority, image),
    )
    .await
}

fn read_engine_image_blocking(
    authority: &crate::infra::path_authority::SharedPathAuthority,
    image: crate::infra::path_authority::EngineImageHandle,
) -> Result<EngineImageData, Error> {
    let (file, declared) = crate::infra::path_authority::engine_image_reader_for(
        authority,
        &image,
        MAX_ENGINE_IMAGE_BYTES,
    )?;
    let bytes = crate::infra::path_authority::read_engine_image_bytes(
        file,
        declared,
        MAX_ENGINE_IMAGE_BYTES,
    )?;
    Ok(EngineImageData {
        mime_type: engine_image_mime_type(&bytes)?.into(),
        bytes,
    })
}

#[tauri::command]
#[specta::specta]
pub async fn issue_opening_book(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<crate::infra::path_authority::OpeningBookHandle, Error> {
    use tauri_plugin_dialog::DialogExt;
    let path = tokio::task::spawn_blocking(move || {
        app.dialog()
            .file()
            .blocking_pick_file()
            .ok_or(Error::Cancellation)?
            .into_path()
            .map_err(|error| Error::native_selection("invalid opening book selection", error))
    })
    .await
    .map_err(map_picker_join)??;
    let authority = state.pgn_path_authority.clone();
    crate::infra::operations::run_accepted_blocking(
        &state.operations,
        "issue_opening_book",
        move || issue_opening_book_blocking(&authority, path),
    )
    .await
}

fn issue_opening_book_blocking(
    authority: &crate::infra::path_authority::SharedPathAuthority,
    path: PathBuf,
) -> Result<crate::infra::path_authority::OpeningBookHandle, Error> {
    let label = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Opening book".into());
    authority.with_mut(|authority| authority.register_opening_book(&path, label))?
}

pub(crate) fn engine_archive_destination_blocking(
    authority: &crate::infra::path_authority::SharedPathAuthority,
    root: crate::infra::path_authority::EngineRootHandle,
) -> Result<crate::infra::path_authority::PathRef, Error> {
    crate::infra::path_authority::with_engine_root_probe(
        authority,
        root.path_ref(),
        crate::infra::path_authority::PathOperation::DownloadArchive,
        &tokio_util::sync::CancellationToken::new(),
        |authority, probe| authority.engine_archive_destination_with_probe(&root, probe),
    )
}

pub(crate) fn register_installed_engine_blocking(
    authority: &crate::infra::path_authority::SharedPathAuthority,
    root: crate::infra::path_authority::EngineRootHandle,
    relative_path: String,
) -> Result<crate::infra::path_authority::EngineHandle, Error> {
    let register = || {
        crate::infra::path_authority::with_engine_root_probe(
            authority,
            root.path_ref(),
            crate::infra::path_authority::PathOperation::EngineInstall,
            &tokio_util::sync::CancellationToken::new(),
            |authority, probe| authority.register_installed_engine(&root, &relative_path, probe),
        )
    };
    match register() {
        Err(original)
            if matches!(
                original.unlabelled(),
                Error::CommittedDurabilityUncertain(_)
            ) =>
        {
            // Registration is get-or-create on the adopted inode. Recover a committed handle
            // after a durability warning, preserving the original failure if lookup also fails.
            register().or(Err(original))
        }
        result => result,
    }
}

#[tauri::command]
#[specta::specta]
pub async fn get_database_folder_status(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<crate::infra::path_authority::FolderStatus, Error> {
    let authority = state.pgn_path_authority.clone();
    crate::infra::operations::run_accepted_blocking(
        &state.operations,
        "get_database_folder_status",
        move || {
            get_database_folder_status_blocking(&authority, &|| {
                crate::infra::path_authority::AppDataDir::for_app(&app)
            })
        },
    )
    .await
}

fn get_database_folder_status_blocking(
    authority: &crate::infra::path_authority::SharedPathAuthority,
    app_data: &dyn Fn() -> Result<crate::infra::path_authority::AppDataDir, Error>,
) -> Result<crate::infra::path_authority::FolderStatus, Error> {
    authority.with_mut(|authority| authority.database_folder_status(app_data))?
}

#[tauri::command]
#[specta::specta]
pub async fn get_engine_folder_status(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<crate::infra::path_authority::FolderStatus, Error> {
    let authority = state.pgn_path_authority.clone();
    crate::infra::operations::run_accepted_blocking(
        &state.operations,
        "get_engine_folder_status",
        move || {
            get_engine_folder_status_blocking(&authority, &|| {
                crate::infra::path_authority::AppDataDir::for_app(&app)
            })
        },
    )
    .await
}

fn get_engine_folder_status_blocking(
    authority: &crate::infra::path_authority::SharedPathAuthority,
    app_data: &dyn Fn() -> Result<crate::infra::path_authority::AppDataDir, Error>,
) -> Result<crate::infra::path_authority::FolderStatus, Error> {
    authority.with_mut(|authority| authority.engine_folder_status(app_data))?
}

#[tauri::command]
#[specta::specta]
pub async fn open_database_workspace(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), Error> {
    use tauri_plugin_opener::OpenerExt;
    let authority = state.pgn_path_authority.clone();
    let lookup_app = app.clone();
    crate::infra::operations::run_accepted_blocking(
        &state.operations,
        "open_database_workspace",
        move || {
            open_database_workspace_blocking(
                &authority,
                &|| crate::infra::path_authority::AppDataDir::for_app(&lookup_app),
                |path| app.opener().open_path(path.to_string_lossy(), None::<&str>),
            )
        },
    )
    .await
}

fn open_database_workspace_blocking(
    authority: &crate::infra::path_authority::SharedPathAuthority,
    app_data: &dyn Fn() -> Result<crate::infra::path_authority::AppDataDir, Error>,
    opener: impl FnOnce(&std::path::Path) -> Result<(), tauri_plugin_opener::Error>,
) -> Result<(), Error> {
    let path = authority.with_mut(|authority| authority.database_folder_open_path(app_data))??;
    open_resolved_folder(&path, opener)
}

#[tauri::command]
#[specta::specta]
pub async fn open_engine_workspace(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), Error> {
    use tauri_plugin_opener::OpenerExt;
    let authority = state.pgn_path_authority.clone();
    let lookup_app = app.clone();
    crate::infra::operations::run_accepted_blocking(
        &state.operations,
        "open_engine_workspace",
        move || {
            open_engine_workspace_blocking(
                &authority,
                &|| crate::infra::path_authority::AppDataDir::for_app(&lookup_app),
                |path| app.opener().open_path(path.to_string_lossy(), None::<&str>),
            )
        },
    )
    .await
}

fn open_engine_workspace_blocking(
    authority: &crate::infra::path_authority::SharedPathAuthority,
    app_data: &dyn Fn() -> Result<crate::infra::path_authority::AppDataDir, Error>,
    opener: impl FnOnce(&std::path::Path) -> Result<(), tauri_plugin_opener::Error>,
) -> Result<(), Error> {
    let path = authority.with_mut(|authority| authority.engine_folder_open_path(app_data))??;
    open_resolved_folder(&path, opener)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::file_workspace::canonical_shell_path;
    use crate::infra::blocking::source_scan::body_at_indent;
    use std::time::Duration;

    #[test]
    fn database_and_engine_workspace_descriptors_preserve_selected_names_and_handles() {
        use crate::infra::path_authority::{PathAuthority, SharedPathAuthority};

        let directory = tempfile::tempdir().unwrap();
        let databases = directory.path().join("MyChessDBs");
        let engines = directory.path().join("MyChessEngines");
        std::fs::create_dir(&databases).unwrap();
        std::fs::create_dir(&engines).unwrap();
        let authority = SharedPathAuthority::installed(
            PathAuthority::open(directory.path().join("registry.json"), vec![]).unwrap(),
        );
        let no_default = || Err(Error::Conflict("unexpected app-data lookup".into()));

        let database = issue_database_workspace_blocking(&authority, databases).unwrap();
        assert_eq!(database.display_name, "MyChessDBs");
        assert_eq!(
            get_database_workspace_blocking(&authority, &no_default).unwrap(),
            database
        );
        let engine = issue_engine_workspace_blocking(&authority, engines).unwrap();
        assert_eq!(engine.display_name, "MyChessEngines");
        assert_eq!(
            get_engine_workspace_blocking(&authority, &no_default).unwrap(),
            engine
        );
    }

    #[test]
    fn database_and_engine_workspace_bodies_default_only_without_a_selection() {
        use crate::infra::path_authority::{
            portable_tests::assert_workspace_body_defaults_only_without_a_selection,
            AppOwnedDefaultRoot,
        };
        for domain in [AppOwnedDefaultRoot::Databases, AppOwnedDefaultRoot::Engines] {
            assert_workspace_body_defaults_only_without_a_selection(domain, |authority, lookup| {
                match domain {
                    AppOwnedDefaultRoot::Databases => {
                        get_database_workspace_blocking(authority, lookup).map(|descriptor| {
                            assert_eq!(descriptor.display_name, "Databases");
                            descriptor.root.path_ref().clone()
                        })
                    }
                    AppOwnedDefaultRoot::Engines => {
                        get_engine_workspace_blocking(authority, lookup).map(|descriptor| {
                            assert_eq!(descriptor.display_name, "Engines");
                            descriptor.root.path_ref().clone()
                        })
                    }
                    _ => unreachable!(),
                }
            });
        }
    }

    #[test]
    fn database_and_engine_workspace_bodies_refuse_unusable_selections_without_defaults() {
        use crate::infra::path_authority::{
            portable_tests::assert_workspace_body_refuses_unusable_selections_without_defaults,
            AppOwnedDefaultRoot,
        };
        for domain in [AppOwnedDefaultRoot::Databases, AppOwnedDefaultRoot::Engines] {
            assert_workspace_body_refuses_unusable_selections_without_defaults(
                domain,
                |authority, lookup| match domain {
                    AppOwnedDefaultRoot::Databases => {
                        get_database_workspace_blocking(authority, lookup)
                            .map(|descriptor| descriptor.root.path_ref().clone())
                    }
                    AppOwnedDefaultRoot::Engines => {
                        get_engine_workspace_blocking(authority, lookup)
                            .map(|descriptor| descriptor.root.path_ref().clone())
                    }
                    _ => unreachable!(),
                },
            );
        }
    }

    #[test]
    fn root_failure_default_database_non_directory_is_unusable() {
        use crate::infra::path_authority::{AppDataDir, PathAuthority, SystemClock};
        let directory = tempfile::tempdir().unwrap();
        let app_data = AppDataDir::for_test(directory.path());
        std::fs::write(directory.path().join("db"), b"not a directory").unwrap();
        let mut authority = PathAuthority::open_with_clock(
            directory.path().join("registry.json"),
            vec![],
            std::sync::Arc::new(SystemClock),
            2,
        )
        .unwrap();
        let error = get_default_database_workspace(&mut authority, &app_data).unwrap_err();
        assert_eq!(
            error.root_failure(),
            Some(crate::error::RootFailure::Unusable)
        );
        assert_eq!(error.category(), crate::error::ErrorCategory::Io);
        assert_eq!(error.to_string(), "I/O failure");
        assert_eq!(
            error.diagnostic(),
            "I/O failure: app-owned default root is not a directory"
        );
    }

    #[test]
    fn open_engine_workspace_redacts_opener_path_and_logs_native_cause() {
        use crate::infra::path_authority::{PathAuthority, SharedPathAuthority};
        let directory = tempfile::tempdir().unwrap();
        let fixture_path = directory.path().canonicalize().unwrap();
        let mut authority = PathAuthority::open_for_engine_test(&fixture_path).unwrap();
        let root = authority
            .get_or_create_engine_root(&fixture_path, "Engines", None)
            .unwrap();
        authority.set_active_engine_root(&root).unwrap();
        let authority = SharedPathAuthority::installed(authority);
        let capture = crate::error::LogCaptureScope::start();
        let cause = format!("opener rejected private path {}", fixture_path.display());
        let no_default = || Err(Error::Conflict("unexpected app-data lookup".into()));
        let error = open_engine_workspace_blocking(&authority, &no_default, |path| {
            assert_eq!(path, canonical_shell_path(&fixture_path).as_path());
            Err(tauri_plugin_opener::Error::Io(std::io::Error::other(
                cause.clone(),
            )))
        })
        .unwrap_err();
        let payload = serde_json::to_value(&error).unwrap();
        assert!(!payload.to_string().contains(&cause));
        assert!(!payload
            .to_string()
            .contains(&fixture_path.display().to_string()));
        assert_eq!(payload["category"], "platform");
        assert!(matches!(&error, Error::TauriOpener(_)));
        assert!(error.diagnostic().contains(&cause));
        assert!(capture
            .messages()
            .iter()
            .any(|message| message.contains(&cause)));
    }

    #[test]
    fn database_folder_status_and_open_cover_leaf_default_and_failure() {
        use crate::error::RootFailure;
        use crate::infra::path_authority::{FolderStatus, PathAuthority, SharedPathAuthority};

        let directory = tempfile::tempdir().unwrap();
        let authority = SharedPathAuthority::installed(
            PathAuthority::open(directory.path().join("registry.json"), vec![]).unwrap(),
        );
        let looked_up = std::cell::Cell::new(false);
        let no_lookup = || {
            looked_up.set(true);
            Err(Error::Conflict("unexpected app-data lookup".into()))
        };
        let idle = get_database_folder_status_blocking(&authority, &no_lookup).unwrap();
        assert_eq!(
            idle,
            FolderStatus {
                display_name: "Databases".into(),
                is_default: true,
                root_failure: None,
            }
        );
        assert!(!looked_up.get());

        let selected = directory.path().join("MyChessDBs");
        std::fs::create_dir(&selected).unwrap();
        issue_database_workspace_blocking(&authority, selected.clone()).unwrap();
        let custom = get_database_folder_status_blocking(&authority, &no_lookup).unwrap();
        assert_eq!(custom.display_name, "MyChessDBs");
        assert!(!custom.is_default);
        assert_eq!(custom.root_failure, None);

        let capture = crate::error::LogCaptureScope::start();
        let cause = format!("opener rejected private path {}", selected.display());
        let error = open_database_workspace_blocking(&authority, &no_lookup, |path| {
            assert_eq!(path, canonical_shell_path(&selected).as_path());
            Err(tauri_plugin_opener::Error::Io(std::io::Error::other(
                cause.clone(),
            )))
        })
        .unwrap_err();
        let payload = serde_json::to_value(&error).unwrap();
        assert!(!payload.to_string().contains(&cause));
        assert!(!payload
            .to_string()
            .contains(&selected.display().to_string()));
        assert!(matches!(&error, Error::TauriOpener(_)));
        assert!(error.diagnostic().contains(&cause));
        assert!(capture
            .messages()
            .iter()
            .any(|message| message.contains(&cause)));

        std::fs::remove_dir(&selected).unwrap();
        let missing = get_database_folder_status_blocking(&authority, &no_lookup).unwrap();
        assert_eq!(missing.display_name, "MyChessDBs");
        assert!(!missing.is_default);
        assert_eq!(missing.root_failure, Some(RootFailure::Missing));

        let missing_open = crate::error::LogCaptureScope::start();
        let error = open_database_workspace_blocking(&authority, &no_lookup, |_| {
            panic!("missing folder must not reach the opener")
        })
        .unwrap_err();
        assert_eq!(error.root_failure(), Some(RootFailure::Missing));
        let payload = serde_json::to_value(&error).unwrap();
        assert!(!payload
            .to_string()
            .contains(&selected.display().to_string()));
        assert!(missing_open.messages().is_empty());
    }

    #[test]
    fn engine_folder_status_covers_leaf_default_and_failure() {
        use crate::error::RootFailure;
        use crate::infra::path_authority::{FolderStatus, PathAuthority, SharedPathAuthority};

        let directory = tempfile::tempdir().unwrap();
        let authority = SharedPathAuthority::installed(
            PathAuthority::open(directory.path().join("registry.json"), vec![]).unwrap(),
        );
        let no_lookup = || Err(Error::Conflict("unexpected app-data lookup".into()));
        let idle = get_engine_folder_status_blocking(&authority, &no_lookup).unwrap();
        assert_eq!(
            idle,
            FolderStatus {
                display_name: "Engines".into(),
                is_default: true,
                root_failure: None,
            }
        );
        let selected = directory.path().join("MyChessEngines");
        std::fs::create_dir(&selected).unwrap();
        issue_engine_workspace_blocking(&authority, selected.clone()).unwrap();
        let custom = get_engine_folder_status_blocking(&authority, &no_lookup).unwrap();
        assert_eq!(custom.display_name, "MyChessEngines");
        assert!(!custom.is_default);
        assert_eq!(custom.root_failure, None);
        std::fs::remove_dir(&selected).unwrap();
        let missing = get_engine_folder_status_blocking(&authority, &no_lookup).unwrap();
        assert_eq!(missing.display_name, "MyChessEngines");
        assert_eq!(missing.root_failure, Some(RootFailure::Missing));
    }

    #[test]
    fn database_folder_open_path_follows_identity_checked_resolution() {
        use crate::file_workspace::{assert_kind_folder_open_path_identity, idle_app_data};
        use crate::infra::path_authority::AppOwnedDefaultRoot;
        let directory = tempfile::tempdir().unwrap();
        let (authority, app_path) = idle_app_data(&directory);
        let selected = directory.path().join("MyChessDBs");
        assert_kind_folder_open_path_identity(
            &authority,
            &app_path,
            &selected,
            AppOwnedDefaultRoot::Databases,
            |authority, lookup| {
                authority
                    .with_mut(|authority| authority.database_folder_open_path(lookup).ok())
                    .unwrap()
            },
            |authority, path| {
                issue_database_workspace_blocking(authority, path).unwrap();
            },
        );
    }

    #[test]
    fn engine_folder_open_path_follows_identity_checked_resolution() {
        use crate::file_workspace::{assert_kind_folder_open_path_identity, idle_app_data};
        use crate::infra::path_authority::AppOwnedDefaultRoot;
        let directory = tempfile::tempdir().unwrap();
        let (authority, app_path) = idle_app_data(&directory);
        let selected = directory.path().join("MyChessEngines");
        assert_kind_folder_open_path_identity(
            &authority,
            &app_path,
            &selected,
            AppOwnedDefaultRoot::Engines,
            |authority, lookup| {
                authority
                    .with_mut(|authority| authority.engine_folder_open_path(lookup).ok())
                    .unwrap()
            },
            |authority, path| {
                issue_engine_workspace_blocking(authority, path).unwrap();
            },
        );
    }

    #[test]
    fn idle_database_and_engine_open_reach_the_default_directory() {
        use crate::file_workspace::{canonical_shell_path, idle_app_data};
        use crate::infra::path_authority::{
            ensure_app_owned_default_dir, AppDataDir, AppOwnedDefaultRoot,
        };
        let directory = tempfile::tempdir().unwrap();
        let (authority, app_path) = idle_app_data(&directory);
        let lookup = || Ok(AppDataDir::for_test(&app_path));
        let databases = canonical_shell_path(
            ensure_app_owned_default_dir(
                &AppDataDir::for_test(&app_path),
                AppOwnedDefaultRoot::Databases,
            )
            .unwrap()
            .path(),
        );
        open_database_workspace_blocking(&authority, &lookup, |path| {
            assert_eq!(path, databases.as_path());
            Ok(())
        })
        .unwrap();
        let engines = canonical_shell_path(
            ensure_app_owned_default_dir(
                &AppDataDir::for_test(&app_path),
                AppOwnedDefaultRoot::Engines,
            )
            .unwrap()
            .path(),
        );
        open_engine_workspace_blocking(&authority, &lookup, |path| {
            assert_eq!(path, engines.as_path());
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn database_and_engine_pickers_seed_from_the_current_folder() {
        let workspace_commands = include_str!("workspace_commands.rs");
        for signature in [
            "async fn issue_database_workspace(",
            "async fn issue_engine_workspace(",
        ] {
            let body = body_at_indent(workspace_commands, signature);
            assert!(
                body.contains("seed_folder_picker(")
                    && body.contains("_folder_open_path(")
                    && body.contains("blocking_pick_folder"),
                "{signature} must seed the folder picker: {body}"
            );
            let start = body
                .find("seed_folder_picker(")
                .unwrap_or_else(|| panic!("{signature} must resolve the current folder: {body}"));
            let pick = body
                .find("blocking_pick_folder")
                .expect("blocking_pick_folder");
            assert!(
                start < pick,
                "{signature} must resolve the start directory before the dialog: {body}"
            );
        }
    }

    #[test]
    fn native_export_keeps_the_file_and_reports_uncertain_durability() {
        let directory = tempfile::tempdir().expect("export directory");
        let path = directory.path().join("board.png");
        crate::infra::fs::set_test_atomic_file_injector(Some(std::sync::Arc::new(
            crate::infra::fs::ParentSyncFault("uncertain"),
        )));
        let error = save_native_export_blocking(path.clone(), "png".into(), b"png".to_vec())
            .expect_err("uncertain durability must be surfaced");
        crate::infra::fs::set_test_atomic_file_injector(None);
        assert!(matches!(
            error,
            Error::CommittedDurabilityUncertain(crate::error::DurabilityStage::NativeExport)
        ));
        assert_eq!(std::fs::read(&path).expect("exported file"), b"png");
        assert!(save_native_export_blocking(path, "png".into(), b"png".to_vec()).is_ok());
    }

    struct HeldNativeExport {
        entered: std::sync::Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
        release: std::sync::Mutex<std::sync::mpsc::Receiver<()>>,
        fail: bool,
    }

    impl crate::infra::fs::AtomicWriterInjector for HeldNativeExport {
        fn inject(&self, point: crate::infra::fs::AtomicFileFaultPoint) -> std::io::Result<()> {
            if point != crate::infra::fs::AtomicFileFaultPoint::Write {
                return Ok(());
            }
            if let Some(entered) = self.entered.lock().unwrap().take() {
                let _ = entered.send(());
            }
            self.release
                .lock()
                .unwrap()
                .recv_timeout(Duration::from_secs(5))
                .map_err(|_| std::io::Error::other("native export release timed out"))?;
            if self.fail {
                Err(std::io::Error::other("injected native export failure"))
            } else {
                Ok(())
            }
        }
    }

    struct NativeExportTestGuard(Option<std::sync::mpsc::Sender<()>>);

    impl NativeExportTestGuard {
        fn release(&mut self) {
            if let Some(release) = self.0.take() {
                let _ = release.send(());
            }
        }
    }

    impl Drop for NativeExportTestGuard {
        fn drop(&mut self) {
            self.release();
            crate::infra::fs::set_test_atomic_file_injector(None);
        }
    }

    #[tokio::test]
    async fn native_export_core_keeps_real_success_and_error_tails_after_caller_drop() {
        for fail in [false, true] {
            let directory = tempfile::tempdir().unwrap();
            let path = directory.path().join("board.png");
            let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
            let (release_tx, release_rx) = std::sync::mpsc::channel();
            let mut guard = NativeExportTestGuard(Some(release_tx));
            crate::infra::fs::set_test_atomic_file_injector(Some(Arc::new(HeldNativeExport {
                entered: std::sync::Mutex::new(Some(entered_tx)),
                release: std::sync::Mutex::new(release_rx),
                fail,
            })));

            let operations = OperationRegistry::default();
            let task_operations = operations.clone();
            let task_path = path.clone();
            let caller = tokio::spawn(async move {
                crate::infra::operations::run_accepted_blocking(
                    &task_operations,
                    "save_board_snapshot",
                    move || {
                        save_native_export_blocking(
                            task_path,
                            "png".into(),
                            b"owned export".to_vec(),
                        )
                    },
                )
                .await
            });
            tokio::time::timeout(Duration::from_secs(5), entered_rx)
                .await
                .unwrap()
                .unwrap();
            caller.abort();
            assert_eq!(
                operations.outstanding_labels().unwrap(),
                vec!["save_board_snapshot"]
            );
            guard.release();
            tokio::time::timeout(Duration::from_secs(5), async {
                while !operations.outstanding_labels().unwrap().is_empty() {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
            if fail {
                assert!(!path.exists());
            } else {
                assert_eq!(std::fs::read(path).unwrap(), b"owned export");
            }
        }
    }

    #[test]
    fn engine_image_install_and_post_install_cleanup_are_pinned_to_the_descriptor() {
        let workspace_commands = include_str!("workspace_commands.rs");
        let body = body_at_indent(workspace_commands, "fn issue_engine_image_blocking<R:");
        assert!(
            body.contains("atomic_replace_leaf_identified("),
            "engine-image installation must use the authorized directory descriptor: {body}"
        );
        assert!(!body.contains(".join("), "{body}");
        assert!(
            !body.contains("crate::infra::fs::atomic_replace("),
            "{body}"
        );
        assert!(
            body.contains("CommittedDurabilityUncertain"),
            "engine-image installation must handle uncertain parent durability: {body}"
        );
        assert!(!body.contains("let (_, installed)"), "{body}");
        let install_at = body
            .find("atomic_replace_leaf_identified(")
            .expect("install through the descriptor");
        let after_install = &body[install_at..];
        assert!(
            after_install.contains("match authority.with_mut(|authority|"),
            "{after_install}"
        );
        let unavailable = after_install
            .split_once("Err(unavailable) =>")
            .expect("both typed acquisition failures share the cleanup arm")
            .1;
        assert!(
            unavailable
                .trim_start()
                .starts_with("Err(engine_image_error_after_cleanup("),
            "{unavailable}"
        );
        let arguments = unavailable
            .split_once("engine_image_error_after_cleanup(")
            .unwrap()
            .1
            .split_once(")),")
            .expect("end of acquisition error cleanup")
            .0;
        assert!(
            arguments.contains("Error::from(unavailable)"),
            "{arguments}"
        );
        assert!(arguments.trim_end().ends_with("None,"), "{arguments}");
        let registration = after_install
            .split_once("register_engine_image(")
            .expect("registration after install")
            .1;
        let arguments = registration
            .split_once("engine_image_error_after_cleanup(")
            .expect("registration error cleanup")
            .1
            .split_once(")),")
            .expect("end of the registration error cleanup call")
            .0;
        assert!(
            arguments.trim_end().ends_with("Some(authority),"),
            "registration error cleanup must forward the authority: {arguments}"
        );
        let cleanup = body_at_indent(workspace_commands, "fn engine_image_error_after_cleanup(");
        assert!(cleanup.contains("remove_leaf_identified("), "{cleanup}");
        assert!(cleanup.contains("Error::with_cleanup("), "{cleanup}");
        assert!(
            cleanup.contains("record_engine_image_cleanup("),
            "{cleanup}"
        );
        assert!(!cleanup.contains("log::error!("), "{cleanup}");
        assert!(
            cleanup.contains("engine image {leaf:?} was removed but parent sync"),
            "{cleanup}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn engine_image_orphan_removal_failure_records_intent_and_preserves_both_errors() {
        use crate::infra::fs::{scoped_test_removal_injector, RemovalFault, RemovalFaultPoint};
        use crate::infra::path_authority::portable_tests::EngineImageCleanupFixture;
        let mut f = EngineImageCleanupFixture::new();
        f.authority.seal_engine_attachments();
        let original = f
            .authority
            .register_engine_image(&f.image_dir, &f.leaf, f.installed, "image".into())
            .unwrap_err();
        let primary = original.diagnostic();
        let guard = scoped_test_removal_injector(std::sync::Arc::new(RemovalFault(
            RemovalFaultPoint::BeforeTopOpen,
        )));
        let error = engine_image_error_after_cleanup(
            &f.image_dir,
            &f.leaf,
            f.installed,
            original,
            Some(&mut f.authority),
        );
        drop(guard);
        assert_engine_image_cleanup_diagnostic(
            &error,
            &primary,
            &f.leaf,
            "cleanup intent recorded",
        );
        assert!(f.image_dir.path().join(&f.leaf).is_file());
        f.reload_and_remove();
    }

    #[cfg(unix)]
    fn assert_engine_image_cleanup_diagnostic(
        error: &Error,
        primary: &str,
        leaf: &OsStr,
        outcome: &str,
    ) {
        let Error::OperationAndCleanup {
            primary: actual_primary,
            cleanup,
        } = error
        else {
            panic!(
                "expected composed engine image error: {}",
                error.diagnostic()
            );
        };
        assert_eq!(actual_primary, primary);
        for expected in [leaf.to_str().unwrap(), "injected removal failure", outcome] {
            assert!(
                cleanup.contains(expected),
                "missing {expected:?}: {cleanup}"
            );
            assert!(
                error.diagnostic().contains(expected),
                "missing {expected:?}: {}",
                error.diagnostic()
            );
        }
        assert!(error.diagnostic().contains(primary));
    }

    #[cfg(unix)]
    #[test]
    fn engine_image_orphan_removal_failure_without_authority_reports_no_intent() {
        use crate::infra::fs::{scoped_test_removal_injector, RemovalFault, RemovalFaultPoint};
        use crate::infra::path_authority::portable_tests::EngineImageCleanupFixture;
        for original in [
            crate::infra::path_authority::AuthorityUnavailable::Poisoned,
            crate::infra::path_authority::AuthorityUnavailable::Uninitialized,
        ] {
            let f = EngineImageCleanupFixture::new();
            let original = Error::from(original);
            let primary = original.diagnostic();
            let guard = scoped_test_removal_injector(std::sync::Arc::new(RemovalFault(
                RemovalFaultPoint::BeforeTopOpen,
            )));
            let error = engine_image_error_after_cleanup(
                &f.image_dir,
                &f.leaf,
                f.installed,
                original,
                None,
            );
            drop(guard);
            assert_engine_image_cleanup_diagnostic(
                &error,
                &primary,
                &f.leaf,
                "not recorded: no path authority",
            );
            f.assert_no_intent();
        }
    }

    #[cfg(unix)]
    #[test]
    fn engine_image_cleanup_helper_reports_registry_write_failure_and_admission_refusal() {
        use crate::infra::fs::{
            install_test_atomic_file_injector, scoped_test_removal_injector, AtomicFileFaultPoint,
            CancelAtomicFileAt, RemovalFault, RemovalFaultPoint,
        };
        use crate::infra::path_authority::portable_tests::EngineImageCleanupFixture;
        for admission in [false, true] {
            let mut f = EngineImageCleanupFixture::new();
            let before = if admission {
                f.fill_admission_bound();
                Some(std::fs::read(&f.registry).unwrap())
            } else {
                None
            };
            let atomic_guard = (!admission).then(|| {
                install_test_atomic_file_injector(std::sync::Arc::new(CancelAtomicFileAt {
                    cancel_at: AtomicFileFaultPoint::Cleanup,
                    fail_at: Some(AtomicFileFaultPoint::Write),
                    cancellation: tokio_util::sync::CancellationToken::new(),
                }))
            });
            let original = Error::Conflict("original registration failure".into());
            let primary = original.diagnostic();
            let guard = scoped_test_removal_injector(std::sync::Arc::new(RemovalFault(
                RemovalFaultPoint::BeforeTopOpen,
            )));
            let error = engine_image_error_after_cleanup(
                &f.image_dir,
                &f.leaf,
                f.installed,
                original,
                Some(&mut f.authority),
            );
            drop(guard);
            drop(atomic_guard);
            let expected = if admission {
                "not recorded: Resource limit: path registry identifier limit reached"
            } else {
                "not recorded, retained in memory: I/O failure: injected Write failure"
            };
            assert_engine_image_cleanup_diagnostic(&error, &primary, &f.leaf, expected);
            if let Some(before) = before {
                assert_eq!(std::fs::read(&f.registry).unwrap(), before);
            } else {
                assert!(!f.registry.exists());
                f.authority
                    .cleanup_engine_images(&f.image_dir, false)
                    .unwrap();
                assert!(!f.image_dir.path().join(&f.leaf).exists());
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn engine_image_cleanup_after_unlink_uncertainty_returns_original_without_intent() {
        use crate::infra::fs::{scoped_test_removal_injector, RemovalFault, RemovalFaultPoint};
        use crate::infra::path_authority::portable_tests::EngineImageCleanupFixture;
        let mut f = EngineImageCleanupFixture::new();
        let guard = scoped_test_removal_injector(std::sync::Arc::new(RemovalFault(
            RemovalFaultPoint::ParentSync,
        )));
        let error = engine_image_error_after_cleanup(
            &f.image_dir,
            &f.leaf,
            f.installed,
            Error::Conflict("registration failed".into()),
            Some(&mut f.authority),
        );
        drop(guard);
        assert!(matches!(error, Error::Conflict(message) if message == "registration failed"));
        assert!(!f.image_dir.path().join(&f.leaf).exists());
        f.assert_no_intent();
    }

    #[test]
    fn engine_image_cleanup_already_absent_returns_original_without_intent() {
        use crate::infra::path_authority::portable_tests::EngineImageCleanupFixture;
        let mut f = EngineImageCleanupFixture::new();
        f.image_dir
            .remove_leaf_identified(&f.leaf, f.installed)
            .unwrap();
        let error = engine_image_error_after_cleanup(
            &f.image_dir,
            &f.leaf,
            f.installed,
            Error::Conflict("registration failed".into()),
            Some(&mut f.authority),
        );
        assert!(matches!(error, Error::Conflict(message) if message == "registration failed"));
        f.assert_no_intent();
    }

    #[test]
    fn engine_image_cleanup_helper_wire_form_omits_leaf_and_native_paths() {
        use crate::infra::path_authority::portable_tests::EngineImageCleanupFixture;
        let mut f = EngineImageCleanupFixture::new();
        // A different installed identity makes descriptor removal refuse on every target.
        let other = f.image_dir.identity();
        let original = Error::Conflict(format!(
            "registration failed under {}",
            f.app_data.display()
        ));
        let error = engine_image_error_after_cleanup(
            &f.image_dir,
            &f.leaf,
            other,
            original,
            Some(&mut f.authority),
        );
        assert!(matches!(error, Error::OperationAndCleanup { .. }));
        let wire = serde_json::to_value(&error).unwrap();
        assert_eq!(wire["category"], "operation-and-cleanup");
        assert_eq!(
            wire["message"],
            "Operation failed; temporary cleanup also failed"
        );
        let payload = serde_json::to_string(&wire).unwrap();
        assert!(!payload.contains(f.leaf.to_str().unwrap()), "{payload}");
        assert!(
            !payload.contains(&f.app_data.to_string_lossy().to_string()),
            "{payload}"
        );
        let encoded_path = serde_json::to_string(&f.app_data.to_string_lossy()).unwrap();
        assert!(
            !payload.contains(&encoded_path[1..encoded_path.len() - 1]),
            "{payload}"
        );
        assert!(f.image_dir.path().join(&f.leaf).is_file());
    }

    #[test]
    fn engine_image_post_install_error_removes_the_orphan() {
        use crate::infra::path_authority::portable_tests::EngineImageCleanupFixture;
        let mut f = EngineImageCleanupFixture::new();

        let error = engine_image_error_after_cleanup(
            &f.image_dir,
            &f.leaf,
            f.installed,
            Error::Conflict("registration failed".into()),
            Some(&mut f.authority),
        );

        assert!(matches!(error, Error::Conflict(message) if message == "registration failed"));
        assert!(!f.image_dir.path().join(&f.leaf).exists());
        f.assert_no_intent();
    }

    #[test]
    fn engine_image_mime_type_accepts_supported_formats_and_rejects_invalid_bytes() {
        assert_eq!(
            engine_image_mime_type(b"\x89PNG\r\n\x1a\nbody").unwrap(),
            "image/png"
        );
        assert_eq!(
            engine_image_mime_type(&[0xff, 0xd8, 0xff, 0xe0]).unwrap(),
            "image/jpeg"
        );
        assert_eq!(engine_image_mime_type(b"GIF87a...").unwrap(), "image/gif");
        assert_eq!(engine_image_mime_type(b"GIF89a...").unwrap(), "image/gif");
        assert_eq!(
            engine_image_mime_type(b"RIFF\x00\x00\x00\x00WEBP").unwrap(),
            "image/webp"
        );

        for invalid in [
            b"".as_slice(),
            b"not an image".as_slice(),
            b"RIFF\x00\x00\x00\x00WAVE".as_slice(),
        ] {
            let err = engine_image_mime_type(invalid).unwrap_err();
            assert!(
                matches!(err, Error::InvalidInput(ref msg) if msg == "engine image must be a PNG, JPEG, GIF, or WebP file"),
                "unexpected error for {invalid:?}: {err:?}"
            );
        }
    }
}
