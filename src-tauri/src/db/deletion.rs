//! Database file deletion and duplicate/empty game removal commands.

use super::*;

#[tauri::command]
#[specta::specta]
pub async fn delete_database(
    file: DatabaseHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), Error> {
    state
        .folder_switch
        .wait_for_migration(
            crate::infra::path_authority::FolderSwitchKind::Database,
            None,
        )
        .await?;
    let operation = state.operations.accept("delete_database")?;
    let cancellation = operation.token();
    let authority = state.pgn_path_authority.clone();
    let repository = Arc::clone(&state.database_repository);
    let search_cache = Arc::clone(&state.search_cache);
    crate::infra::operations::run_native_operation(operation, "delete_database", async move {
        BLOCKING_GATEWAY
            .spawn_cancellable(cancellation, move |token| {
                delete_database_blocking(&authority, &repository, &search_cache, file, token)
            })
            .await
    })
    .await
}

// index_sidecar_removal_identity compares only source.object for preferred sidecars,
// but requires source == *expected_source for legacy (preferred=false) sidecars.
// IndexSource::from_database never carries these sentinels, so full equality fails
// and the legacy file stays. The object field still uses the recovered target identity.
pub(super) const ABSENT_PRIMARY_INDEX_REVISION: u64 = u64::MAX;
pub(super) const ABSENT_PRIMARY_INDEX_DATABASE_LENGTH: u64 = u64::MAX;
pub(super) const ABSENT_PRIMARY_INDEX_DATABASE_MODIFIED_NANOS: u128 = u128::MAX;

pub(crate) fn delete_database_blocking(
    authority: &crate::infra::path_authority::SharedPathAuthority,
    repository: &DatabaseRepository,
    search_cache: &SearchCache,
    file: DatabaseHandle,
    cancellation: &CancellationToken,
) -> Result<(), Error> {
    #[cfg(test)]
    database_command_checkpoint("delete_database", &file);
    let (target, absent) = match resolve_database(authority, &file, PathOperation::DatabaseMutate) {
        Ok(target) => (target, false),
        Err(error) if error.is_missing_entry() => {
            match authority.with_mut(|authority| {
                authority.recover_database_deletion(&file, error, cancellation)
            })?? {
                DatabaseDeleteRecovery::Absent(target) => (target, true),
                DatabaseDeleteRecovery::Present => (
                    resolve_database(authority, &file, PathOperation::DatabaseMutate)?,
                    false,
                ),
            }
        }
        Err(error) => return Err(error),
    };
    let _content_deletion =
        content_validation::begin_delete(repository, target.path(), cancellation)?;
    let expected_source = if absent {
        IndexSource {
            object: target.identity(),
            revision: ABSENT_PRIMARY_INDEX_REVISION,
            database_length: ABSENT_PRIMARY_INDEX_DATABASE_LENGTH,
            database_modified_nanos: ABSENT_PRIMARY_INDEX_DATABASE_MODIFIED_NANOS,
        }
    } else {
        let identity = match repository.identity_from_probe(&target, cancellation, true) {
            Ok(identity) => identity,
            Err(error) if crate::error::is_sqlite_notadb(&error) => {
                repository.identity_from_probe(&target, cancellation, false)?
            }
            Err(error) => return Err(error),
        };
        IndexSource::from_database_identity(&identity)?
    };
    let mut committed_removal: Option<CommittedRemoval> = None;
    let unlink_result = repository.delete_exclusive_cancellable(&target, cancellation, || {
        if absent {
            if let Some(collections) = authority.collections()? {
                #[cfg(test)]
                ABSENT_PRIMARY_BEFORE_COLLECTION_GUARD.with(|slot| {
                    if let Some(hook) = slot.borrow_mut().take() {
                        hook();
                    }
                });
                collections.guard_database(&file, PathOperation::DatabaseMutate)?;
            }
        } else {
            guard_database_mutation(authority, &file, PathOperation::DatabaseMutate)?;
        }
        search_cache.invalidate_database(&target);
        let result = unlink_database_files(&target, &expected_source);
        search_cache.invalidate_database(&target);
        let result = result?;
        committed_removal = Some(result);
        Ok(())
    });
    if committed_removal.is_some() {
        content_validation::forget(repository, target.path());
    }
    let Some(mut committed_removal) = committed_removal else {
        return unlink_result;
    };
    committed_removal.record(unlink_result, "database lease release", target.path());

    let registry_result = (|| authority.with_mut(|authority| authority.remove_database(&file))?)();
    committed_removal.record(registry_result, "database registry cleanup", target.path());
    committed_removal.finish()
}

#[cfg(test)]
std::thread_local! {
    pub(super) static ABSENT_PRIMARY_BEFORE_COLLECTION_GUARD:
        std::cell::RefCell<Option<Box<dyn FnOnce()>>> = const { std::cell::RefCell::new(None) };
    static UNLINK_PRIMARY_AFTER_IDENTITY_PROBE_HOOK:
        std::cell::RefCell<Option<Box<dyn FnOnce()>>> = const { std::cell::RefCell::new(None) };
    static UNLINK_SIDECAR_AFTER_IDENTITY_PROBE_HOOK:
        std::cell::RefCell<Option<Box<dyn FnOnce()>>> = const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
pub(super) fn set_unlink_primary_after_identity_probe_hook(hook: Option<Box<dyn FnOnce()>>) {
    UNLINK_PRIMARY_AFTER_IDENTITY_PROBE_HOOK.with(|slot| *slot.borrow_mut() = hook);
}

#[cfg(test)]
pub(super) fn run_unlink_primary_after_identity_probe_hook() {
    UNLINK_PRIMARY_AFTER_IDENTITY_PROBE_HOOK.with(|slot| {
        if let Some(hook) = slot.borrow_mut().take() {
            hook();
        }
    });
}

#[cfg(test)]
pub(super) fn set_unlink_sidecar_after_identity_probe_hook(hook: Option<Box<dyn FnOnce()>>) {
    UNLINK_SIDECAR_AFTER_IDENTITY_PROBE_HOOK.with(|slot| *slot.borrow_mut() = hook);
}

#[cfg(test)]
pub(super) fn run_unlink_sidecar_after_identity_probe_hook() {
    UNLINK_SIDECAR_AFTER_IDENTITY_PROBE_HOOK.with(|slot| {
        if let Some(hook) = slot.borrow_mut().take() {
            hook();
        }
    });
}

#[cfg(test)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum UnlinkProbeStage {
    Identity,
    ReadOpen,
    OpenedIdentity,
    SourceRead,
}

#[cfg(test)]
std::thread_local! {
    pub(super) static UNLINK_PROBE_FAULT:
        std::cell::RefCell<Option<(UnlinkProbeStage, std::ffi::OsString, std::io::ErrorKind)>> = const { std::cell::RefCell::new(None) };
    static UNLINK_PROBE_OPENED_IDENTITY_MISMATCH:
        std::cell::RefCell<Option<std::ffi::OsString>> = const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
pub(super) fn set_unlink_probe_opened_identity_mismatch(leaf: Option<std::ffi::OsString>) {
    UNLINK_PROBE_OPENED_IDENTITY_MISMATCH.with(|slot| *slot.borrow_mut() = leaf);
}

#[cfg(test)]
pub(super) fn inject_unlink_probe_opened_identity_mismatch(
    leaf: &OsStr,
    identity: (u64, u64),
) -> (u64, u64) {
    UNLINK_PROBE_OPENED_IDENTITY_MISMATCH.with(|slot| {
        let mut armed_leaf = slot.borrow_mut();
        if armed_leaf.as_deref() == Some(leaf) {
            *armed_leaf = None;
            (identity.0, identity.1.wrapping_add(1))
        } else {
            identity
        }
    })
}

#[cfg(test)]
pub(super) fn inject_unlink_probe_fault<T, E: From<std::io::Error>>(
    stage: UnlinkProbeStage,
    leaf: Option<&OsStr>,
    result: Result<T, E>,
) -> Result<T, E> {
    UNLINK_PROBE_FAULT.with(|slot| {
        let mut fault = slot.borrow_mut();
        match fault.as_ref() {
            Some((point, fault_leaf, kind))
                if *point == stage && leaf.is_none_or(|leaf| leaf == fault_leaf) =>
            {
                let kind = *kind;
                *fault = None;
                return Err(std::io::Error::new(kind, "injected sidecar probe failure").into());
            }
            _ => {}
        }
        result
    })
}

/// Judges provenance and binds removal to the identity of that same file. POSIX retains
/// the `statat` → `unlinkat` instant inside `remove_entry_at`; Windows deletes through the
/// checked handle and has no such window. A sidecar written under a database object that
/// has since changed is kept as foreign; loaders reject it and later generation replaces it.
/// `PermissionDenied` at any probe stage keeps either index name and deletion continues.
/// A preferred file whose header and source are not a decodable archive is removed;
/// the same defect on the legacy name keeps that file.
/// An Ok result means the primary was removed or was already missing at unlink;
/// any retained error must be reported after cache and registry cleanup, including
/// a later SQLite sidecar failure.
pub(super) fn unlink_database_files(
    target: &DatabaseFileTarget,
    expected_source: &IndexSource,
) -> Result<CommittedRemoval, Error> {
    fn remember_sidecar_error(
        error: Error,
        parent: &File,
        leaf: &OsStr,
        retained: &mut Option<Error>,
    ) -> Result<(), Error> {
        match crate::infra::path_authority::classify_probe_error(&error, parent, leaf) {
            crate::infra::path_authority::ProbeErrorClass::NotFound => Ok(()),
            crate::infra::path_authority::ProbeErrorClass::Reparse
            | crate::infra::path_authority::ProbeErrorClass::WrongKind => {
                if let Some(sidecar_error) = retained.as_ref() {
                    log::warn!(
                        "database sidecar removal failed after durability uncertainty: {sidecar_error}"
                    );
                }
                Err(Error::InvalidInput(
                    "workspace sidecar must be a regular file".into(),
                ))
            }
            crate::infra::path_authority::ProbeErrorClass::Malformed
            | crate::infra::path_authority::ProbeErrorClass::MappedFile
            | crate::infra::path_authority::ProbeErrorClass::Other => {
                if matches!(error, Error::CommittedDurabilityUncertain(_)) {
                    if retained.is_some() {
                        log::warn!(
                            "database sidecar removal durability remained uncertain: {}",
                            error.diagnostic()
                        );
                    } else {
                        *retained = Some(error);
                    }
                    Ok(())
                } else {
                    if let Some(sidecar_error) = retained.as_ref() {
                        log::warn!(
                            "database sidecar removal failed after durability uncertainty: {sidecar_error}"
                        );
                    }
                    Err(error)
                }
            }
        }
    }

    fn remove_sidecar(
        parent: &File,
        leaf: &OsStr,
        identity: (u64, u64),
        unlinked: &mut usize,
        retained: &mut Option<Error>,
    ) -> Result<(), Error> {
        match remove_entry_at(parent, leaf, identity, false) {
            Ok(()) => {
                *unlinked += 1;
                Ok(())
            }
            Err(error) => match error {
                Error::CommittedDurabilityUncertain(_) => {
                    *unlinked += 1;
                    remember_sidecar_error(error, parent, leaf, retained)
                }
                error => remember_sidecar_error(error, parent, leaf, retained),
            },
        }
    }

    fn unlink_judged_sidecar(
        parent: &File,
        leaf: &OsStr,
        expected_source: &IndexSource,
        preferred: bool,
        unlinked: &mut usize,
        retained: &mut Option<Error>,
    ) -> Result<(), Error> {
        match index_sidecar_removal_identity(parent, leaf, expected_source, preferred) {
            Ok(Some(identity)) => remove_sidecar(parent, leaf, identity, unlinked, retained),
            Ok(None) => Ok(()),
            Err(error) => remember_sidecar_error(error, parent, leaf, retained),
        }
    }

    let preferred_leaf = search_index::preferred_sidecar_leaf(target.leaf());
    let integrity_leaf = search_index::integrity_stamp_leaf(target.leaf());
    let legacy_leaf = search_index::legacy_sidecar_leaf(target.leaf());
    let mut unlinked = 0;
    let mut durability = None;

    // Refuse unsafe SQLite sidecars before deleting anything, but retain their
    // identities so they can only be unlinked after the primary is removed.
    let mut sqlite_sidecars = Vec::with_capacity(2);
    for suffix in ["-wal", "-shm"] {
        let mut leaf = target.leaf().to_os_string();
        leaf.push(suffix);
        match entry_identity_at(target.parent(), &leaf, false) {
            Ok(identity) => sqlite_sidecars.push((leaf, identity)),
            Err(error) => remember_sidecar_error(error, target.parent(), &leaf, &mut durability)?,
        }
    }

    unlink_judged_sidecar(
        target.parent(),
        &preferred_leaf,
        expected_source,
        true,
        &mut unlinked,
        &mut durability,
    )?;

    match entry_identity_at(target.parent(), &integrity_leaf, false) {
        Ok(identity) => remove_sidecar(
            target.parent(),
            &integrity_leaf,
            identity,
            &mut unlinked,
            &mut durability,
        )?,
        Err(error) => {
            remember_sidecar_error(error, target.parent(), &integrity_leaf, &mut durability)?
        }
    }

    if legacy_leaf != preferred_leaf {
        unlink_judged_sidecar(
            target.parent(),
            &legacy_leaf,
            expected_source,
            false,
            &mut unlinked,
            &mut durability,
        )?;
    }

    #[cfg(test)]
    run_unlink_primary_after_identity_probe_hook();
    let mut primary_result =
        remove_entry_at(target.parent(), target.leaf(), target.identity(), false);
    match primary_result {
        Ok(()) => unlinked += 1,
        Err(Error::CommittedDurabilityUncertain(_)) => {
            unlinked += 1;
        }
        Err(Error::Conflict(_)) => {
            if let Some(sidecar_error) = durability {
                log::warn!(
                    "database sidecar removal durability was uncertain before primary failure: {sidecar_error}"
                );
            }
            return Err(Error::Conflict("database changed before deletion".into()));
        }
        Err(ref error) if error.is_missing_entry() => primary_result = Ok(()),
        Err(error) => {
            if let Some(sidecar_error) = durability {
                log::warn!(
                    "database sidecar removal durability was uncertain before primary failure: {sidecar_error}"
                );
            }
            return Err(error);
        }
    }
    let mut committed_removal = CommittedRemoval::new(unlinked, durability);
    committed_removal.record(primary_result, "database primary removal", target.path());
    for (leaf, identity) in sqlite_sidecars {
        #[cfg(test)]
        run_unlink_sidecar_after_identity_probe_hook();
        let result = remove_entry_at(target.parent(), &leaf, identity, false);
        if result.is_ok() || matches!(result, Err(Error::CommittedDurabilityUncertain(_))) {
            committed_removal.add_removed_entries(1);
        }
        let result = result.or_else(|error| {
            if matches!(error, Error::CommittedDurabilityUncertain(_)) {
                Err(error)
            } else {
                remember_sidecar_error(error, target.parent(), &leaf, &mut None)
            }
        });
        if let Err(error) = &result {
            log::warn!(
                "database SQLite sidecar removal failed after primary deletion for {}: {}",
                leaf.to_string_lossy(),
                error.diagnostic()
            );
        }
        committed_removal.record(result, "database SQLite sidecar removal", target.path());
    }
    Ok(committed_removal)
}

#[cfg(all(test, unix))]
pub(super) fn legacy_sidecar_removal_identity(
    parent: &File,
    leaf: &OsStr,
    expected_source: &IndexSource,
) -> Result<Option<(u64, u64)>, Error> {
    index_sidecar_removal_identity(parent, leaf, expected_source, false)
}

pub(super) fn index_sidecar_removal_identity(
    parent: &File,
    leaf: &OsStr,
    expected_source: &IndexSource,
    preferred: bool,
) -> Result<Option<(u64, u64)>, Error> {
    use crate::infra::path_authority::{
        classify_probe_error, opened_file_identity, ProbeErrorClass,
    };

    let mut judged_identity = None;
    let probe = (|| {
        let result = entry_identity_at(parent, leaf, false);
        #[cfg(test)]
        let result = inject_unlink_probe_fault(UnlinkProbeStage::Identity, Some(leaf), result);
        let identity = result?;
        judged_identity = Some(identity);
        let result = crate::infra::fs::open_regular_at(
            parent,
            leaf,
            crate::infra::fs::RegularFileAccess::ReadOnly,
        );
        #[cfg(test)]
        let result = inject_unlink_probe_fault(UnlinkProbeStage::ReadOpen, Some(leaf), result);
        let mut file = result?;
        let result = opened_file_identity(&file);
        #[cfg(test)]
        let result =
            inject_unlink_probe_fault(UnlinkProbeStage::OpenedIdentity, Some(leaf), result);
        #[cfg(test)]
        let result =
            result.map(|identity| inject_unlink_probe_opened_identity_mismatch(leaf, identity));
        if result? != identity {
            return Err(Error::Conflict(
                "index sidecar changed before deletion".into(),
            ));
        }
        let source = search_index::read_index_source(&mut file).map_err(Error::from);
        drop(file);
        source
    })();

    let remove = match probe {
        Ok(source) => {
            if preferred {
                source.object == expected_source.object
            } else {
                source == *expected_source
            }
        }
        Err(error) => match classify_probe_error(&error, parent, leaf) {
            ProbeErrorClass::NotFound => false,
            ProbeErrorClass::Malformed => preferred,
            ProbeErrorClass::Reparse | ProbeErrorClass::WrongKind if !preferred => false,
            ProbeErrorClass::Other if matches!(&error, Error::Io(error) if error.kind() == std::io::ErrorKind::PermissionDenied) => {
                false
            }
            _ => return Err(error),
        },
    };
    if !remove {
        return Ok(None);
    }
    #[cfg(test)]
    run_unlink_sidecar_after_identity_probe_hook();
    Ok(judged_identity)
}

pub(super) fn delete_orphaned_data(db: &mut SqliteConnection) -> Result<(), Error> {
    db.batch_execute(
        "
        DELETE FROM Players WHERE ID != 0 AND ID NOT IN (
            SELECT WhiteID FROM Games UNION SELECT BlackID FROM Games
        );
        DELETE FROM Events WHERE ID != 0 AND ID NOT IN (
            SELECT EventID FROM Games
        );
        DELETE FROM Sites WHERE ID != 0 AND ID NOT IN (
            SELECT SiteID FROM Games
        );
        ",
    )?;

    Ok(())
}

pub(super) fn refresh_derived_database_data(db: &mut SqliteConnection) -> Result<(), Error> {
    refresh_derived_database_data_from(db, event_summaries::RowSource::IndexedDirtyEvents)
}

pub(super) fn refresh_derived_database_data_from(
    db: &mut SqliteConnection,
    source: event_summaries::RowSource,
) -> Result<(), Error> {
    event_summaries::refresh_event_summaries(db, source)?;
    let game_count: i64 = games::table.count().get_result(db)?;
    update_info_count(db, "GameCount", game_count)?;

    let player_count: i64 = players::table.count().get_result(db)?;
    update_info_count(db, "PlayerCount", player_count)?;

    let event_count: i64 = events::table.count().get_result(db)?;
    update_info_count(db, "EventCount", event_count)?;

    let site_count: i64 = sites::table.count().get_result(db)?;
    update_info_count(db, "SiteCount", site_count)?;

    Ok(())
}

pub(super) fn remove_orphans_and_refresh_derived_data(
    db: &mut SqliteConnection,
) -> Result<(), Error> {
    delete_orphaned_data(db)?;
    refresh_derived_database_data(db)
}

#[tauri::command]
#[specta::specta]
pub async fn delete_duplicated_games(
    file: DatabaseHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), Error> {
    state
        .folder_switch
        .wait_for_migration(
            crate::infra::path_authority::FolderSwitchKind::Database,
            None,
        )
        .await?;
    let operation = state.operations.accept("delete_duplicated_games")?;
    let cancellation = operation.token();
    let authority = state.pgn_path_authority.clone();
    let repository = Arc::clone(&state.database_repository);
    let search_cache = Arc::clone(&state.search_cache);
    crate::infra::operations::run_native_operation(
        operation,
        "delete_duplicated_games",
        async move {
            BLOCKING_GATEWAY
                .spawn_cancellable(cancellation, move |token| {
                    delete_duplicated_games_blocking(
                        &authority,
                        &repository,
                        &search_cache,
                        file,
                        token,
                    )
                })
                .await
        },
    )
    .await
}

pub(super) fn delete_duplicated_games_blocking(
    authority: &crate::infra::path_authority::SharedPathAuthority,
    repository: &DatabaseRepository,
    search_cache: &SearchCache,
    file: DatabaseHandle,
    cancellation: &CancellationToken,
) -> Result<(), Error> {
    #[cfg(test)]
    database_command_checkpoint("delete_duplicated_games", &file);
    let target = resolve_database(authority, &file, PathOperation::DatabaseMutate)?;

    with_validated_mutation(
        repository,
        search_cache,
        &target,
        cancellation,
        authority,
        &file,
        delete_duplicated_games_transaction,
    )
}

pub(super) fn delete_duplicated_games_transaction(db: &mut SqliteConnection) -> Result<(), Error> {
    // f-20261115-07: one game can be stored with NULL, PGN-placeholder or empty Date/Round and
    // with NULL or `*` Result (import, export → re-import, save from a tab). Compare those
    // columns with absence folded, through the signature's own marker set (d-20261102-06).
    let date = SignatureField::Date.normalized_sql();
    let round = SignatureField::Round.normalized_sql();
    let has_photo_rows = scoresheet_photos_table_exists(db)?
        && scoresheet_photos::table
            .select(scoresheet_photos::game_id)
            .limit(1)
            .first::<i32>(db)
            .optional()?
            .is_some();
    // When ScoresheetPhotos has rows, rank photo-carrying duplicates ahead of plain ones in the
    // single duplicate window so a photo game survives without a second scan. When the table is
    // absent or empty, run the original query unchanged.
    let (join_clause, order_clause) = if has_photo_rows {
        (
            "\n                LEFT JOIN ScoresheetPhotos sp ON sp.GameID = g.ID",
            "CASE WHEN sp.Photos IS NOT NULL THEN 0 ELSE 1 END, g.ID",
        )
    } else {
        ("", "g.ID")
    };
    db.batch_execute(&format!(
        "
        DELETE FROM Games
        WHERE ID IN (
            SELECT ID
            FROM (
                SELECT g.ID,
                    ROW_NUMBER() OVER (PARTITION BY g.EventID, g.SiteID, {round}, g.WhiteID, g.BlackID, g.Moves, {date}, NULLIF(g.UTCTime, ''), g.FEN, COALESCE(g.Result, '*'), g.WhiteElo, g.BlackElo, g.TimeControl ORDER BY {order_clause}) AS RowNum
                FROM Games g{join_clause}
            ) AS Subquery
            WHERE RowNum > 1
        );
        ",
    ))?;

    remove_orphans_and_refresh_derived_data(db)?;

    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn delete_empty_games(
    file: DatabaseHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), Error> {
    state
        .folder_switch
        .wait_for_migration(
            crate::infra::path_authority::FolderSwitchKind::Database,
            None,
        )
        .await?;
    let operation = state.operations.accept("delete_empty_games")?;
    let cancellation = operation.token();
    let authority = state.pgn_path_authority.clone();
    let repository = Arc::clone(&state.database_repository);
    let search_cache = Arc::clone(&state.search_cache);
    crate::infra::operations::run_native_operation(operation, "delete_empty_games", async move {
        BLOCKING_GATEWAY
            .spawn_cancellable(cancellation, move |token| {
                delete_empty_games_blocking(&authority, &repository, &search_cache, file, token)
            })
            .await
    })
    .await
}

pub(crate) fn delete_empty_games_blocking(
    authority: &crate::infra::path_authority::SharedPathAuthority,
    repository: &DatabaseRepository,
    search_cache: &SearchCache,
    file: DatabaseHandle,
    cancellation: &CancellationToken,
) -> Result<(), Error> {
    #[cfg(test)]
    database_command_checkpoint("delete_empty_games", &file);
    let target = resolve_database(authority, &file, PathOperation::DatabaseMutate)?;

    with_validated_mutation(
        repository,
        search_cache,
        &target,
        cancellation,
        authority,
        &file,
        delete_empty_games_transaction,
    )
}

pub(super) fn delete_empty_games_transaction(db: &mut SqliteConnection) -> Result<(), Error> {
    diesel::delete(games::table.filter(games::ply_count.eq(0))).execute(db)?;

    remove_orphans_and_refresh_derived_data(db)?;

    Ok(())
}
