//! Pure reconcile planner for Studio Library sync (S-4).

use crate::{
    infra::path_authority::FileWorkspaceHandle,
    library_sync::{
        scan::ScannedCandidate,
        state::SyncState,
        wire::{LibraryFileKind, LibraryPrecondition, StudioLibraryFile},
        ABSENCE_DELETE_THRESHOLD,
    },
};
use std::collections::HashMap;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum SyncAction {
    Delete {
        studio_file_id: String,
    },
    Put {
        studio_file_id: String,
        handle: FileWorkspaceHandle,
        name: String,
        kind: LibraryFileKind,
        precondition: LibraryPrecondition,
    },
}

/// Computes the ordered reconcile actions:
/// 1. Deletes first (deselected entries immediately; absent entries only after
///    [`ABSENCE_DELETE_THRESHOLD`] consecutive complete scans at least one scan interval apart).
///    Never deletes on an unavailable folder, never deletes absent entries on an incomplete scan,
///    and never deletes an id not in `state`.
/// 2. Creates in path order (selected, readable, within byte cap, not memoised-rejected).
/// 3. Replaces in path order (bytes, normalised name or kind differ from the server row).
pub(crate) fn plan_reconcile(
    candidates: &[ScannedCandidate],
    matched_ids: &[Option<String>],
    state: &SyncState,
    server_files: &[StudioLibraryFile],
    complete_scan: bool,
    folder_available: bool,
) -> Vec<SyncAction> {
    if !folder_available {
        return Vec::new();
    }

    let server_by_id: HashMap<&str, &StudioLibraryFile> = server_files
        .iter()
        .map(|file| (file.studio_file_id.as_str(), file))
        .collect();

    let mut actions = Vec::new();

    // 1. Deletes first.
    for (id, entry) in &state.entries {
        if !server_by_id.contains_key(id.as_str()) {
            continue;
        }
        let delete_deselected = !entry.selected;
        let delete_absent = complete_scan && entry.missed_scans >= ABSENCE_DELETE_THRESHOLD;
        if delete_deselected || delete_absent {
            actions.push(SyncAction::Delete {
                studio_file_id: id.clone(),
            });
        }
    }

    // 2. Creates (in path order) and 3. Replaces (in path order).
    let mut creates = Vec::new();
    let mut replaces = Vec::new();

    for (candidate, maybe_id) in candidates.iter().zip(matched_ids.iter()) {
        let Some(id) = maybe_id.as_ref() else {
            continue;
        };
        let Some(entry) = state.entries.get(id) else {
            continue;
        };
        if !entry.selected || candidate.oversized || candidate.unreadable {
            continue;
        }
        let Some(sha) = candidate.content_sha256.as_ref() else {
            continue;
        };
        if entry
            .last_rejection
            .as_ref()
            .is_some_and(|rej| rej.content_sha256 == *sha && rej.code.is_file_intrinsic())
        {
            continue;
        }
        match server_by_id.get(id.as_str()) {
            None => {
                creates.push(SyncAction::Put {
                    studio_file_id: id.clone(),
                    handle: candidate.handle.clone(),
                    name: candidate.normalized_name.clone(),
                    kind: candidate.kind,
                    precondition: LibraryPrecondition::Create,
                });
            }
            Some(server_file) => {
                let bytes_match = server_file.content_sha256.as_deref() == Some(sha.as_str());
                let name_match = server_file.name == candidate.normalized_name;
                let kind_match = server_file.kind == candidate.kind;
                if !(bytes_match && name_match && kind_match) {
                    replaces.push(SyncAction::Put {
                        studio_file_id: id.clone(),
                        handle: candidate.handle.clone(),
                        name: candidate.normalized_name.clone(),
                        kind: candidate.kind,
                        precondition: LibraryPrecondition::Replace(server_file.version),
                    });
                }
            }
        }
    }

    actions.extend(creates);
    actions.extend(replaces);
    actions
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        infra::path_authority::PathRef,
        library_sync::{
            scan::normalize_library_name,
            state::{FileRejection, SyncEntry},
            wire::LibraryRejectionCode,
        },
    };
    use std::ffi::OsString;

    fn make_cand(handle: &str, name: &str, kind: LibraryFileKind, sha: &str) -> ScannedCandidate {
        ScannedCandidate {
            handle: FileWorkspaceHandle::new(PathRef {
                id: handle.to_owned(),
            }),
            locator: vec![OsString::from(name)],
            name: name.to_owned(),
            normalized_name: normalize_library_name(name),
            folder_label: String::new(),
            kind,
            revision: Some("r1".into()),
            content_sha256: Some(sha.to_owned()),
            oversized: false,
            unreadable: false,
        }
    }

    fn make_entry(name: &str, selected: bool, missed_scans: u32) -> SyncEntry {
        SyncEntry {
            locator: vec![OsString::from(name)],
            handle: None,
            selected,
            last_content_sha256: None,
            missed_scans,
            last_rejection: None,
        }
    }

    #[test]
    fn planner_orders_deletes_then_creates_in_path_order_then_replaces() {
        let mut state = SyncState::off();
        state
            .entries
            .insert("id-del".into(), make_entry("del.pgn", false, 0));
        state
            .entries
            .insert("id-abs".into(), make_entry("abs.pgn", true, 2));
        state
            .entries
            .insert("id-c1".into(), make_entry("a.pgn", true, 0));
        state
            .entries
            .insert("id-c2".into(), make_entry("b.pgn", true, 0));
        state
            .entries
            .insert("id-rep".into(), make_entry("c.pgn", true, 0));
        state
            .entries
            .insert("id-same".into(), make_entry("d.pgn", true, 0));

        let server = vec![
            StudioLibraryFile {
                studio_file_id: "id-del".into(),
                name: "del".into(),
                kind: LibraryFileKind::Games,
                version: 1,
                content_sha256: Some("s".into()),
            },
            StudioLibraryFile {
                studio_file_id: "id-abs".into(),
                name: "abs".into(),
                kind: LibraryFileKind::Games,
                version: 1,
                content_sha256: Some("s".into()),
            },
            StudioLibraryFile {
                studio_file_id: "id-unmanaged".into(),
                name: "other-machine".into(),
                kind: LibraryFileKind::Games,
                version: 1,
                content_sha256: Some("s".into()),
            },
            StudioLibraryFile {
                studio_file_id: "id-rep".into(),
                name: "old-name".into(),
                kind: LibraryFileKind::Games,
                version: 3,
                content_sha256: Some("sha-c".into()),
            },
            StudioLibraryFile {
                studio_file_id: "id-same".into(),
                name: "d".into(),
                kind: LibraryFileKind::Games,
                version: 2,
                content_sha256: Some("sha-d".into()),
            },
        ];

        let candidates = vec![
            make_cand("h1", "a.pgn", LibraryFileKind::Repertoire, "sha-a"),
            make_cand("h2", "b.pgn", LibraryFileKind::Games, "sha-b"),
            make_cand("h3", "c.pgn", LibraryFileKind::Games, "sha-c"),
            make_cand("h4", "d.pgn", LibraryFileKind::Games, "sha-d"),
        ];
        let ids = vec![
            Some("id-c1".into()),
            Some("id-c2".into()),
            Some("id-rep".into()),
            Some("id-same".into()),
        ];

        let actions = plan_reconcile(&candidates, &ids, &state, &server, true, true);
        assert_eq!(actions.len(), 5);
        assert_eq!(
            actions[0],
            SyncAction::Delete {
                studio_file_id: "id-abs".into()
            }
        );
        assert_eq!(
            actions[1],
            SyncAction::Delete {
                studio_file_id: "id-del".into()
            }
        );
        assert!(matches!(
            &actions[2],
            SyncAction::Put {
                studio_file_id,
                precondition: LibraryPrecondition::Create,
                ..
            } if studio_file_id == "id-c1"
        ));
        assert!(matches!(
            &actions[3],
            SyncAction::Put {
                studio_file_id,
                precondition: LibraryPrecondition::Create,
                ..
            } if studio_file_id == "id-c2"
        ));
        assert!(matches!(
            &actions[4],
            SyncAction::Put {
                studio_file_id,
                precondition: LibraryPrecondition::Replace(3),
                ..
            } if studio_file_id == "id-rep"
        ));
    }

    #[test]
    fn memoised_intrinsic_rejection_skips_upload_until_bytes_change() {
        let mut state = SyncState::off();
        let mut entry = make_entry("bad.pgn", true, 0);
        entry.last_rejection = Some(FileRejection {
            content_sha256: "sha-bad".into(),
            code: LibraryRejectionCode::InvalidPgn,
            game_number: Some(2),
        });
        state.entries.insert("id-bad".into(), entry);

        let same_bytes = vec![make_cand(
            "h1",
            "bad.pgn",
            LibraryFileKind::Games,
            "sha-bad",
        )];
        let ids = vec![Some("id-bad".into())];
        assert!(plan_reconcile(&same_bytes, &ids, &state, &[], true, true).is_empty());

        let new_bytes = vec![make_cand(
            "h1",
            "bad.pgn",
            LibraryFileKind::Games,
            "sha-fixed",
        )];
        assert_eq!(
            plan_reconcile(&new_bytes, &ids, &state, &[], true, true).len(),
            1
        );
    }

    #[test]
    fn non_intrinsic_rejection_is_retried() {
        let mut state = SyncState::off();
        let mut entry = make_entry("ok.pgn", true, 0);
        entry.last_rejection = Some(FileRejection {
            content_sha256: "sha-ok".into(),
            code: LibraryRejectionCode::AccountFileLimit,
            game_number: None,
        });
        state.entries.insert("id-ok".into(), entry);
        let candidates = vec![make_cand("h1", "ok.pgn", LibraryFileKind::Games, "sha-ok")];
        let ids = vec![Some("id-ok".into())];
        assert_eq!(
            plan_reconcile(&candidates, &ids, &state, &[], true, true).len(),
            1
        );
    }

    #[test]
    fn unavailable_folder_or_incomplete_scan_blocks_absence_delete() {
        let mut state = SyncState::off();
        state
            .entries
            .insert("id-abs".into(), make_entry("abs.pgn", true, 2));
        let server = vec![StudioLibraryFile {
            studio_file_id: "id-abs".into(),
            name: "abs".into(),
            kind: LibraryFileKind::Games,
            version: 1,
            content_sha256: Some("s".into()),
        }];
        assert!(plan_reconcile(&[], &[], &state, &server, true, false).is_empty());
        assert!(plan_reconcile(&[], &[], &state, &server, false, true).is_empty());
    }
}
