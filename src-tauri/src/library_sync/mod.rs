//! Native one-way sync of Studio PGN files to the private ChessRiddle Library.

pub(crate) mod commands;
pub(crate) mod planner;
pub(crate) mod scan;
pub(crate) mod state;
pub(crate) mod wire;
pub(crate) mod worker;

use crate::infra::path_authority::FileWorkspaceHandle;
use serde::{Deserialize, Serialize};
use specta::Type;

pub(crate) use worker::{initialize, shutdown, LibrarySyncOwner};

/// Number of consecutive complete scans (at least one scan interval apart) that must miss a file
/// before it is deleted from the website Library (S-4, D5).
pub(crate) const ABSENCE_DELETE_THRESHOLD: u32 = 2;

/// Closed command error vocabulary for Library sync IPC commands.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) enum LibrarySyncError {
    Unavailable,
    Busy,
    LocalStorage,
    InvalidWorkspace,
    NotActive,
}

/// How turning Library sync off treats files already synced to the website.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) enum LibrarySyncTurnOffMode {
    Keep,
    Remove,
}

/// Closed per-file sync status vocabulary exposed to the renderer.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum LibrarySyncFileStatus {
    Synced,
    Pending,
    Uploading,
    NotSelected,
    TooLarge,
    TooManyMoves,
    TooManyGames,
    #[serde(rename_all = "camelCase")]
    InvalidPgn {
        game_number: Option<u32>,
    },
    UnsupportedVariant,
    TooComplex,
    CommentTooLong,
    Empty,
    LibraryFull,
    StorageFull,
    Unreadable,
    Rejected,
}

impl LibrarySyncFileStatus {
    pub(crate) fn is_attention(&self) -> bool {
        matches!(
            self,
            Self::TooLarge
                | Self::TooManyMoves
                | Self::TooManyGames
                | Self::InvalidPgn { .. }
                | Self::UnsupportedVariant
                | Self::TooComplex
                | Self::CommentTooLong
                | Self::Empty
                | Self::LibraryFull
                | Self::StorageFull
                | Self::Unreadable
                | Self::Rejected
        )
    }
}

/// One candidate PGN file in the Library sync snapshot.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LibrarySyncFile {
    pub handle: FileWorkspaceHandle,
    pub name: String,
    pub folder_label: String,
    pub selected: bool,
    pub status: LibrarySyncFileStatus,
}

/// Closed overall Library sync state vocabulary exposed to the renderer.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "status", rename_all = "camelCase")]
pub(crate) enum LibrarySyncState {
    Off,
    OtherFolder,
    Syncing { done: u32, total: u32 },
    Synced,
    Attention { count: u32 },
    Removing { done: u32, total: u32 },
    Offline,
    ServerBusy,
    ServerError,
    SignInNeeded,
    Unavailable,
    FolderUnavailable,
    LocalError,
}

/// Full Library sync snapshot for one workspace.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LibrarySyncSnapshot {
    pub workspace: FileWorkspaceHandle,
    pub revision: u32,
    pub available: bool,
    pub state: LibrarySyncState,
    pub files: Vec<LibrarySyncFile>,
}

/// Monotonic change signal emitted to the renderer (at most 4 Hz); the renderer refetches the
/// snapshot for its active workspace.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LibrarySyncChanged {
    pub revision: u32,
}
