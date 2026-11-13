use super::*;
use rusqlite::OptionalExtension;

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct PendingBatch {
    pub(super) id: Uuid,
    pub(super) source: FileWorkspaceHandle,
    #[serde(default)]
    pub(super) owned_source: Option<FileWorkspaceHandle>,
    source_revision: String,
    identity: Option<(u64, u64)>,
    #[serde(default)]
    prepared_generation: Option<String>,
    #[serde(default)]
    result_digest: Option<String>,
    #[serde(default)]
    pub(super) completed: bool,
    #[serde(default)]
    pub(super) coverage: Option<ProviderDownload>,
}

impl PendingBatch {
    pub(super) fn clear_preparation(&mut self) {
        self.prepared_generation = None;
        self.result_digest = None;
    }
}

#[derive(Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppendOutcome {
    pub appended: i32,
    pub committed: bool,
    pub index_ready: bool,
    pub durability_confirmed: bool,
}

pub(super) fn batch_error(error: rusqlite::Error) -> Error {
    log::warn!("collection membership projection failed: {error}");
    Error::Conflict("collection membership could not be checked".into())
}

pub(super) fn conflict() -> Error {
    Error::Conflict("game identities require reconciliation, the collection and downloaded batch have been preserved".into())
}

/// Membership is derived again under the PGN edit owner. The temporary SQLite projection and
/// range scanner retain at most one bounded game body, independent of collection byte size.
fn append_absent(
    source: &mut crate::infra::inode_ownership::OwnedFile,
    ranges: &[pgn::GameRange],
    batch: &mut crate::infra::inode_ownership::OwnedFile,
    batch_ranges: &[pgn::GameRange],
    target: &mut File,
    context: (&CollectionService, &Record, &str),
    cancellation: &CancellationToken,
) -> Result<i32, Error> {
    let (service, record, generation) = context;
    let account = record.account.as_ref();
    if account.is_none() {
        pgn::copy_range(source, target, 0, source.metadata()?.len(), cancellation)?;
        let mut appended = 0i32;
        for range in batch_ranges {
            cancellation_check(cancellation)?;
            append_range(batch, target, *range, cancellation)?;
            appended = appended
                .checked_add(1)
                .ok_or_else(|| Error::ResourceLimit("batch has too many games".into()))?;
        }
        return Ok(appended);
    }
    let mut membership = legacy::open(service, record)?;
    let binding = legacy::binding(record)?;
    membership.execute_batch("CREATE TEMP TABLE Source(Ordinal INTEGER PRIMARY KEY,ID TEXT,Fingerprint TEXT NOT NULL,Stamp TEXT NOT NULL,LegacyFingerprint TEXT NOT NULL); CREATE INDEX SourceID ON Source(ID); CREATE INDEX SourceFingerprint ON Source(Fingerprint); CREATE INDEX SourceLegacyFingerprint ON Source(LegacyFingerprint); CREATE TEMP TABLE Batch(Ordinal INTEGER PRIMARY KEY,ID TEXT,Fingerprint TEXT NOT NULL,LegacyFingerprint TEXT NOT NULL); CREATE INDEX BatchID ON Batch(ID); CREATE INDEX BatchFingerprint ON Batch(Fingerprint); CREATE INDEX BatchLegacyFingerprint ON Batch(LegacyFingerprint); CREATE TEMP TABLE Seen(ID TEXT PRIMARY KEY,Fingerprint TEXT NOT NULL);").map_err(batch_error)?;
    let transaction = membership.transaction().map_err(batch_error)?;
    if let Some(account) = account {
        transaction
            .execute_batch("CREATE TEMP TABLE Omitted(ID TEXT PRIMARY KEY);")
            .map_err(batch_error)?;
        for (ordinal, range) in ranges.iter().enumerate() {
            cancellation_check(cancellation)?;
            let (bytes, game) = identity_range(source, *range, cancellation)?;
            let id = readable_provider_game_id(&bytes, account)?;
            let Some(game) = game else {
                if let Some(id) = id {
                    transaction
                        .execute("INSERT OR IGNORE INTO Omitted VALUES(?)", [id])
                        .map_err(batch_error)?;
                }
                continue;
            };
            transaction
                .execute(
                    "INSERT INTO Source VALUES(?,?,?,?,?)",
                    rusqlite::params![
                        ordinal as i64,
                        id,
                        linked_semantic_fingerprint(&game, account)?,
                        pgn::game_stamp(&bytes),
                        legacy_semantic_fingerprint(&game, account)
                    ],
                )
                .map_err(batch_error)?;
        }
        legacy::revalidate_source(&transaction, account, &binding, generation)?;
        let mut skipped = 0usize;
        for (ordinal, range) in batch_ranges.iter().enumerate() {
            cancellation_check(cancellation)?;
            let (bytes, game) = identity_range(batch, *range, cancellation)?;
            let Some(game) = game else {
                skipped += 1;
                continue;
            };
            let id = provider_game_id(&bytes, account)?;
            // An ID carried only by omitted source games is already present. Check after
            // restoration so a parsable occurrence restored from Evidence keeps its identity check.
            let present_only_in_omitted_source: bool = transaction.query_row("SELECT EXISTS(SELECT 1 FROM Omitted WHERE ID=?1) AND NOT EXISTS(SELECT 1 FROM Source WHERE ID=?1)", [&id], |row| row.get(0)).map_err(batch_error)?;
            if present_only_in_omitted_source {
                continue;
            }
            transaction
                .execute(
                    "INSERT INTO Batch VALUES(?,?,?,?)",
                    rusqlite::params![
                        ordinal as i64,
                        id,
                        linked_semantic_fingerprint(&game, account)?,
                        legacy_semantic_fingerprint(&game, account)
                    ],
                )
                .map_err(batch_error)?;
        }
        if skipped != 0 {
            let pending = record
                .pending
                .as_ref()
                .map_or_else(|| "none".to_owned(), |pending| pending.id.to_string());
            log::info!(
                "collection {} pending batch {} skipped {} unindexable batch games",
                record.id,
                pending,
                skipped
            );
        }
        // A legacy occurrence cannot be assigned between distinct known IDs, and conflicting
        // evidence for one known ID is never resolved by arrival order or timestamp.
        legacy::check_affected_evidence(&transaction, account)?;
        let ambiguous: i64 = transaction.query_row("SELECT (SELECT count(*) FROM (SELECT ID FROM Batch WHERE ID IS NOT NULL GROUP BY ID HAVING count(DISTINCT Fingerprint)>1)) + (SELECT count(*) FROM (SELECT ID FROM Source WHERE ID IS NOT NULL GROUP BY ID HAVING count(DISTINCT Fingerprint)>1)) + (SELECT count(*) FROM (SELECT Fingerprint FROM Source WHERE ID IS NULL AND EXISTS (SELECT 1 FROM Batch WHERE Batch.Fingerprint=Source.Fingerprint) GROUP BY Fingerprint HAVING count(*)>1)) + (SELECT count(*) FROM (SELECT Batch.Fingerprint FROM Batch JOIN Source ON Batch.Fingerprint=Source.Fingerprint WHERE Source.ID IS NULL GROUP BY Batch.Fingerprint HAVING count(DISTINCT Batch.ID)>1)) + (SELECT count(*) FROM Batch WHERE ID IS NOT NULL AND NOT EXISTS (SELECT 1 FROM Source WHERE Source.ID=Batch.ID) AND EXISTS (SELECT 1 FROM Source WHERE Source.Fingerprint=Batch.Fingerprint AND Source.ID IS NULL) AND EXISTS (SELECT 1 FROM Source WHERE Source.Fingerprint=Batch.Fingerprint AND Source.ID IS NOT NULL))", [], |row| row.get(0)).map_err(batch_error)?;
        if ambiguous != 0 {
            return Err(conflict());
        }
    }
    let size = source.metadata()?.len();
    pgn::copy_range(source, target, 0, size, cancellation)?;
    let mut appended = 0i32;
    for (ordinal, range) in batch_ranges.iter().enumerate() {
        cancellation_check(cancellation)?;
        let mut absent = true;
        if account.is_some() {
            let identity: Option<(Option<String>, String)> = transaction
                .query_row(
                    "SELECT ID,Fingerprint FROM Batch WHERE Ordinal=?",
                    [ordinal as i64],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()
                .map_err(batch_error)?;
            let Some((id, fingerprint)) = identity else {
                continue;
            };
            if let Some(id) = &id {
                let conflicts: i64 = transaction
                    .query_row(
                        "SELECT count(*) FROM Source WHERE ID=? AND Fingerprint!=?",
                        rusqlite::params![id, fingerprint],
                        |row| row.get(0),
                    )
                    .map_err(batch_error)?;
                if conflicts != 0 {
                    return Err(conflict());
                }
                let present: i64 = transaction.query_row("SELECT (SELECT count(*) FROM Source WHERE ID=? OR (ID IS NULL AND Fingerprint=?)) + (SELECT count(*) FROM Seen WHERE ID=?)", rusqlite::params![id,fingerprint,id], |row| row.get(0)).map_err(batch_error)?;
                absent = present == 0;
                if !absent {
                    legacy::assign(
                        &transaction,
                        account.ok_or_else(conflict)?,
                        &binding,
                        generation,
                        id,
                        &fingerprint,
                    )?;
                }
                transaction
                    .execute(
                        "INSERT OR IGNORE INTO Seen VALUES(?,?)",
                        rusqlite::params![id, fingerprint],
                    )
                    .map_err(batch_error)?;
            } else {
                let (present, incoming): (i64,i64) = transaction.query_row("SELECT (SELECT count(*) FROM Source WHERE Fingerprint=?),(SELECT count(*) FROM Batch WHERE Fingerprint=?)", rusqlite::params![fingerprint,fingerprint], |row| Ok((row.get(0)?,row.get(1)?))).map_err(batch_error)?;
                if present > 1 || incoming > 1 {
                    return Err(conflict());
                }
                absent = present == 0;
            }
        }
        if absent {
            append_range(batch, target, *range, cancellation)?;
            appended = appended
                .checked_add(1)
                .ok_or_else(|| Error::ResourceLimit("batch has too many games".into()))?;
        }
    }
    if let Some(account) = account {
        legacy::remember_source_fingerprints(&transaction, account)?;
    }
    transaction.commit().map_err(batch_error)?;
    service.root.descriptor().sync_all()?;
    Ok(appended)
}

fn append_range(
    batch: &mut crate::infra::inode_ownership::OwnedFile,
    target: &mut File,
    range: pgn::GameRange,
    cancellation: &CancellationToken,
) -> Result<(), Error> {
    target.write_all(b"\n\n")?;
    pgn::copy_range(batch, target, range.start, range.end, cancellation)
}

impl CollectionService {
    pub(super) fn validate_reselection_batch(
        &self,
        authority: &SharedPathAuthority,
        record: &Record,
        token: &CancellationToken,
    ) -> Result<(), Error> {
        let current = self.record(record.id, token)?;
        if let Some(expected) = current
            .pending
            .as_ref()
            .and_then(|pending| pending.result_digest.as_ref())
        {
            let mut source = Self::snapshot(record, authority)?.file;
            if digest_file(&mut source, token)? == *expected {
                return Err(Error::Conflict(
                    "finish recovery of the committed batch before selecting another source".into(),
                ));
            }
        }
        Ok(())
    }

    fn set_pending(
        &self,
        collection: Uuid,
        pending: Option<PendingBatch>,
        cancellation: &CancellationToken,
    ) -> Result<(), Error> {
        let mut guard = self.lock(cancellation)?;
        let mut registry = Self::state(&mut guard)?.clone();
        if registry.inactive_migration_index(collection) {
            return Err(Error::StaleGame);
        }
        let record = registry
            .records
            .iter_mut()
            .find(|record| record.id == collection)
            .ok_or(Error::StaleGame)?;
        record.pending = pending;
        self.save(&mut guard, registry)
    }

    pub(super) fn stage_batch(
        &self,
        authority: &SharedPathAuthority,
        collection: Uuid,
        source: FileWorkspaceHandle,
        cancellation: &CancellationToken,
    ) -> Result<PendingBatch, Error> {
        self.require_active(collection, cancellation)?;
        let staging = self.batch_locks.lease(collection);
        let _staging = staging.lock_cancellable(cancellation)?;
        let snapshot = authority.with_mut(|authority| {
            authority
                .resolve(source.path_ref(), PathOperation::ReadPgn, &[])?
                .pgn_snapshot()
        })??;
        let prior = self.record(collection, cancellation)?.pending;
        if let Some(pending) = &prior {
            let leaf = format!("{}-batch.pgn", pending.id);
            let owned_input = self
                .internal_file(authority, &leaf, vec![PathOperation::ReadPgn])
                .ok()
                .map(FileWorkspaceHandle::new)
                .as_ref()
                == Some(&source);
            if !owned_input
                && (pending.source != source
                    || pending.source_revision != pgn::revision_string(&snapshot))
            {
                return Err(Error::Conflict("another batch needs recovery before this input can be appended, both inputs have been preserved".into()));
            }
            if pending.completed {
                return Ok(pending.clone());
            }
            match entry_identity_at(self.root.descriptor(), OsStr::new(&leaf), false) {
                Ok(identity) if Some(identity) == pending.identity => return Ok(pending.clone()),
                Ok(_) => {
                    return Err(Error::Conflict(
                        "pending batch ownership cannot be confirmed".into(),
                    ))
                }
                Err(error) if error.is_missing_entry() && !pending.completed => {}
                Err(error) => return Err(error),
            }
        }
        let receipt = CollectionService::state(&mut *self.lock(cancellation)?)?
            .downloads
            .iter()
            .find(|receipt| {
                receipt.file == source && receipt.revision == pgn::revision_string(&snapshot)
            })
            .cloned();
        if receipt.as_ref().is_some_and(|receipt| {
            self.record(collection, cancellation)
                .map(|record| record.account.as_ref() != Some(&receipt.account))
                .unwrap_or(true)
        }) {
            return Err(Error::Conflict(
                "provider batch belongs to another account collection".into(),
            ));
        }
        let mut pending = prior.unwrap_or_else(|| PendingBatch {
            id: Uuid::new_v4(),
            source,
            owned_source: None,
            source_revision: pgn::revision_string(&snapshot),
            identity: None,
            prepared_generation: None,
            result_digest: None,
            completed: false,
            coverage: receipt,
        });
        self.set_pending(collection, Some(pending.clone()), cancellation)?;
        let mut bytes = snapshot.file.try_clone()?;
        let size = snapshot.revision.size;
        let leaf = format!("{}-batch.pgn", pending.id);
        let installed = crate::infra::fs::atomic_create_at_identified_with_precommit(
            self.root.descriptor(),
            OsStr::new(&leaf),
            || {
                if snapshot.current_revision()? != snapshot.revision {
                    return Err(Error::StaleGame);
                }
                cancellation_check(cancellation)
            },
            |file| {
                pgn::copy_range(&mut bytes, file, 0, size, cancellation)?;
                pending.identity = Some(authority::opened_file_identity(file)?);
                self.set_pending(collection, Some(pending.clone()), cancellation)
            },
        )?;
        require_durable(
            installed.outcome,
            crate::error::DurabilityStage::NativeExport,
        )?;
        pending.owned_source = Some(FileWorkspaceHandle::new(self.internal_file(
            authority,
            &leaf,
            vec![PathOperation::ReadPgn],
        )?));
        self.set_pending(collection, Some(pending.clone()), cancellation)?;
        Ok(pending)
    }

    pub(crate) async fn append_batch(
        self: Arc<Self>,
        authority: SharedPathAuthority,
        collection: Uuid,
        source: FileWorkspaceHandle,
        cancellation: CancellationToken,
    ) -> Result<AppendOutcome, Error> {
        let service = Arc::clone(&self);
        let native_authority = authority.clone();
        let (record, pending, batch_snapshot, batch_ranges, generation, already_committed) = BLOCKING_GATEWAY.spawn_cancellable(cancellation.clone(), move |token| {
            let pending = service.stage_batch(&native_authority, collection, source, token)?;
            let record = service.record(collection, token)?;
            #[cfg(test)]
            if let Some(hook) = service.append_admission_hook.lock().unwrap().clone() { hook.notify_and_wait(); }
            if pending.completed { return Ok((record, pending, None, Arc::<[pgn::GameRange]>::from([]), String::new(), true)); }
            let leaf = format!("{}-batch.pgn", pending.id);
            if Some(entry_identity_at(service.root.descriptor(), OsStr::new(&leaf), false)?) != pending.identity { return Err(Error::Conflict("pending batch ownership cannot be confirmed".into())); }
            let handle = FileWorkspaceHandle::new(service.internal_file(&native_authority, &leaf, vec![PathOperation::ReadPgn])?);
            let snapshot = native_authority.with_mut(|authority| authority.resolve(handle.path_ref(), PathOperation::ReadPgn, &[])?.pgn_snapshot())??;
            let (_, ranges) = pgn::scan_current_blocking(snapshot, &service.pgn_repository, token)?;
            let snapshot = native_authority.with_mut(|authority| authority.resolve(handle.path_ref(), PathOperation::ReadPgn, &[])?.pgn_snapshot())??;
            let current = CollectionService::snapshot(&record, &native_authority)?;
            let generation = pgn::revision_string(&current);
            let already_committed = pending.completed || pending.result_digest.as_ref().map(|expected| digest_file(&mut current.file.try_clone()?, token).map(|actual| actual == *expected)).transpose()?.unwrap_or(false);
            if !already_committed && record.account.is_none() && pending.prepared_generation.as_ref().is_some_and(|expected| *expected != generation) {
                return Err(Error::Conflict("the collection changed during an unfinished append, both versions require reconciliation".into()));
            }
            Ok((record, pending, Some(snapshot), ranges, generation, already_committed))
        }).await?;
        if already_committed {
            let owner = self.pgn_repository.collection_edit_lock(collection)?;
            let _owner = tokio::select! {
                guard = owner.lock() => guard,
                _ = cancellation.cancelled() => return Err(Error::Cancellation),
            };
            let service = Arc::clone(&self);
            let batch_id = pending.id;
            #[cfg(test)]
            let injector = self.pgn_repository.atomic_file_injector()?;
            let completion = BLOCKING_GATEWAY
                .spawn_cancellable(CancellationToken::new(), move |token| {
                    #[cfg(test)]
                    let _fault = injector.map(crate::infra::fs::install_test_atomic_file_injector);
                    service.validate_binding(&authority, &record.file, &Some(record.binding()))?;
                    if let Some(expected) = &pending.result_digest {
                        let mut source = Self::snapshot(&record, &authority)?.file;
                        if digest_file(&mut source, token)? != *expected {
                            return Err(Error::StaleGame);
                        }
                    }
                    authority.with_mut(|authority| {
                        authority.confirm_collection_source_durability(&record.file)
                    })??;
                    Ok(service
                        .refresh(&authority, collection, token)
                        .and_then(|_| {
                            service.finish_pending(&authority, collection, pending, token)
                        }))
                })
                .await;
            let durability_confirmed = completion.is_ok();
            let completion = completion.and_then(std::convert::identity);
            let index_ready = completion.is_ok();
            if let Err(error) = completion {
                log::warn!("collection {collection} batch {batch_id} committed recovery remains unconfirmed: {}", error.diagnostic());
            }
            return Ok(AppendOutcome {
                appended: 0,
                committed: true,
                index_ready,
                durability_confirmed,
            });
        }
        let resolved = authority.with_mut(|authority| {
            authority.resolve(record.file.path_ref(), PathOperation::WritePgn, &[])
        })??;
        let binding = record.binding();
        let batch_snapshot = batch_snapshot
            .ok_or_else(|| Error::Conflict("pending batch has no readable input".into()))?;
        let mut prepared = pending.clone();
        prepared.prepared_generation = Some(generation.clone());
        let prepared_generation = generation.clone();
        let prepared_service = Arc::clone(&self);
        let result = pgn::transform_file_core(
            resolved,
            generation,
            self.pgn_repository.clone(),
            pgn::PgnCapabilityRebind::new(authority.clone(), &record.file).qualified(binding),
            cancellation.clone(),
            move |source, ranges, target, token| {
                #[cfg(test)]
                let _fault = prepared_service
                    .batch_preparation_injector
                    .lock()
                    .unwrap()
                    .clone()
                    .map(crate::infra::fs::install_test_atomic_file_injector);
                let mut batch = batch_snapshot.file;
                let appended = append_absent(
                    source,
                    ranges,
                    &mut batch,
                    &batch_ranges,
                    target,
                    (&prepared_service, &record, &prepared_generation),
                    token,
                )?;
                prepared.result_digest = Some(digest_file(target, token)?);
                prepared_service.set_pending(collection, Some(prepared), token)?;
                Ok(appended)
            },
        )
        .await;
        let (appended, durability_confirmed) = match result {
            Ok(appended) => (appended, true),
            Err(Error::CommittedDurabilityUncertain(
                crate::error::DurabilityStage::PgnEdit
                | crate::error::DurabilityStage::PgnCapabilityRebind
                | crate::error::DurabilityStage::PgnCacheInvalidation
                | crate::error::DurabilityStage::CollectionIndexRefresh,
            )) => {
                return Ok(AppendOutcome {
                    appended: 0,
                    committed: true,
                    index_ready: false,
                    durability_confirmed: false,
                })
            }
            Err(error) => return Err(error),
        };
        // Publication already happened. Cancellation and index errors from here must never tell
        // the caller that no append occurred or trigger an automatic non-idempotent retry.
        let service = Arc::clone(&self);
        let batch_id = pending.id;
        let completion = BLOCKING_GATEWAY
            .spawn_cancellable(CancellationToken::new(), move |token| {
                service.refresh(&authority, collection, token)?;
                service.finish_pending(&authority, collection, pending, token)
            })
            .await;
        let index_ready = completion.is_ok();
        if let Err(error) = completion {
            log::warn!("collection {collection} batch {batch_id} committed append refresh or cleanup failed: {}", error.diagnostic());
        }
        Ok(AppendOutcome {
            appended,
            committed: true,
            index_ready,
            durability_confirmed,
        })
    }

    pub(super) fn finish_pending(
        &self,
        authority: &SharedPathAuthority,
        collection: Uuid,
        mut pending: PendingBatch,
        cancellation: &CancellationToken,
    ) -> Result<(), Error> {
        let staging = self.batch_locks.lease(collection);
        let _staging = staging.lock_cancellable(cancellation)?;
        match self.record(collection, cancellation)?.pending {
            Some(current) if current.id == pending.id => {}
            None => return Ok(()),
            Some(_) => return Err(Error::StaleGame),
        }
        pending.completed = true;
        self.set_pending(collection, Some(pending.clone()), cancellation)?;
        if let Some(receipt) = &pending.coverage {
            let mut guard = self.lock(cancellation)?;
            let mut registry = Self::state(&mut guard)?.clone();
            let record = registry
                .records
                .iter_mut()
                .find(|record| record.id == collection)
                .ok_or(Error::StaleGame)?;
            if record.account.as_ref() != Some(&receipt.account) {
                return Err(conflict());
            }
            if coverage_cursor_advances_without_gap(receipt.since_ms, record.coverage_cursor_ms) {
                record.coverage_cursor_ms = Some(receipt.through_ms);
                record.coverage_cursor_current = receipt.coverage_cursor_current;
            }
            self.save(&mut guard, registry)?;
        }
        let leaf = format!("{}-batch.pgn", pending.id);
        let identity = pending
            .identity
            .ok_or_else(|| Error::Conflict("pending batch has no owned identity".into()))?;
        match remove_entry_at(self.root.descriptor(), OsStr::new(&leaf), identity, false) {
            Ok(()) => {}
            Err(error) if error.is_missing_entry() => {}
            Err(error) => return Err(error),
        }
        if let Some(owned) = &pending.owned_source {
            authority.with_mut(|authority| {
                authority.forget_collection_batch(owned, &self.root, OsStr::new(&leaf), identity)
            })??;
        }
        self.set_pending(collection, None, cancellation)
    }

    pub(super) fn pending_source(
        &self,
        authority: &SharedPathAuthority,
        collection: Uuid,
        cancellation: &CancellationToken,
    ) -> Result<Option<FileWorkspaceHandle>, Error> {
        let Some(pending) = self.record(collection, cancellation)?.pending else {
            return Ok(None);
        };
        if pending.completed {
            self.finish_pending(authority, collection, pending, cancellation)?;
            return Ok(None);
        }
        let leaf = format!("{}-batch.pgn", pending.id);
        match entry_identity_at(self.root.descriptor(), OsStr::new(&leaf), false) {
            Ok(identity) if Some(identity) == pending.identity => {
                let owned = FileWorkspaceHandle::new(self.internal_file(
                    authority,
                    &leaf,
                    vec![PathOperation::ReadPgn],
                )?);
                if pending.owned_source.as_ref() != Some(&owned) {
                    let mut guard = self.lock(cancellation)?;
                    let mut registry = Self::state(&mut guard)?.clone();
                    if let Some(current) = registry
                        .records
                        .iter_mut()
                        .find(|record| record.id == collection)
                        .and_then(|record| record.pending.as_mut())
                        .filter(|current| current.id == pending.id)
                    {
                        current.owned_source = Some(owned.clone());
                        self.save(&mut guard, registry)?;
                    }
                }
                Ok(Some(owned))
            }
            Ok(_) => Err(Error::Conflict(
                "pending batch ownership cannot be confirmed".into(),
            )),
            Err(error) if error.is_missing_entry() => Ok(Some(pending.source)),
            Err(error) => Err(error),
        }
    }
}

pub(super) fn digest_file(
    file: &mut (impl Read + Seek),
    cancellation: &CancellationToken,
) -> Result<String, Error> {
    file.seek(SeekFrom::Start(0))?;
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        cancellation_check(cancellation)?;
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

pub(crate) async fn append_collection_batch(
    state: &AppState,
    collection: &str,
    source: FileWorkspaceHandle,
    cancellation: CancellationToken,
) -> Result<AppendOutcome, Error> {
    crate::infra::platform_support::off_unix_refusal("PGN atomic replacement", cfg!(unix))?;
    let service = state
        .pgn_path_authority
        .collections()?
        .ok_or_else(|| Error::Conflict("linked collections are unavailable".into()))?;
    let collection = Uuid::parse_str(collection)
        .map_err(|_| Error::InvalidInput("invalid collection ID".into()))?;
    service
        .append_batch(
            state.pgn_path_authority.clone(),
            collection,
            source,
            cancellation,
        )
        .await
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn append_collection_games(
    collection: String,
    source: FileWorkspaceHandle,
    state: tauri::State<'_, AppState>,
) -> Result<AppendOutcome, Error> {
    crate::infra::platform_support::off_unix_refusal("PGN atomic replacement", cfg!(unix))?;
    let operation = state.operations.accept("append_collection_games")?;
    let state = state.inner().clone();
    let cancellation = operation.token();
    crate::infra::operations::run_native_operation(
        operation,
        "append_collection_games",
        async move { append_collection_batch(&state, &collection, source, cancellation).await },
    )
    .await
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::path::Path;

    fn game(id: Option<&str>, moves: &str, comment: &str) -> String {
        format!("[Event \"Fixture\"]\n[Site \"Chess.com\"]\n[Date \"2026.10.01\"]\n[UTCTime \"12:00:00\"]\n[White \"Player\"]\n[Black \"Opponent\"]\n[Result \"1-0\"]\n{}[Custom \"kept\"]\n\n1. {moves} {{{comment}}} 1-0\n\n", id.map(|id| format!("[Link \"https://www.chess.com/game/live/{id}\"]\n")).unwrap_or_default())
    }

    fn scanned(
        path: &Path,
    ) -> (
        crate::infra::inode_ownership::OwnedFile,
        Arc<[pgn::GameRange]>,
    ) {
        let mut authority =
            authority::PathAuthority::open(path.with_extension("authority.json"), vec![]).unwrap();
        let handle = authority
            .get_or_create_persistent_file(path, "fixture", vec![PathOperation::ReadPgn])
            .unwrap()
            .id;
        let snapshot = authority
            .resolve(&handle, PathOperation::ReadPgn, &[])
            .unwrap()
            .pgn_snapshot()
            .unwrap();
        let file = snapshot.file.try_clone().unwrap();
        let (_, ranges) = pgn::scan_current_blocking(
            snapshot,
            &PgnRepository::default(),
            &CancellationToken::new(),
        )
        .unwrap();
        (file, ranges)
    }

    fn append_fixture(source: &str, batch: &str) -> (Result<i32, Error>, Vec<u8>) {
        let directory = tempfile::tempdir().unwrap();
        let source_path = directory.path().join("source.pgn");
        let batch_path = directory.path().join("batch.pgn");
        std::fs::write(&source_path, source).unwrap();
        std::fs::write(&batch_path, batch).unwrap();
        let (mut source_file, source_ranges) = scanned(&source_path);
        let (mut batch_file, batch_ranges) = scanned(&batch_path);
        let output_path = directory.path().join("output.pgn");
        let mut output = File::create(&output_path).unwrap();
        let fixture = super::super::tests::Fixture::new();
        fixture.create("source", source, WorkspaceFileType::Game);
        let collection = fixture.list().pop().unwrap();
        fixture.account(&collection.id, "chesscom");
        let record = fixture
            .service
            .record(
                Uuid::parse_str(&collection.id).unwrap(),
                &CancellationToken::new(),
            )
            .unwrap();
        let result = append_absent(
            &mut source_file,
            &source_ranges,
            &mut batch_file,
            &batch_ranges,
            &mut output,
            (&fixture.service, &record, &collection.generation),
            &CancellationToken::new(),
        );
        drop(output);
        assert_eq!(
            std::fs::read(&source_path).unwrap(),
            source.as_bytes(),
            "source bytes changed before publication"
        );
        assert_eq!(
            std::fs::read(&batch_path).unwrap(),
            batch.as_bytes(),
            "downloaded batch changed during reconciliation"
        );
        (result, std::fs::read(output_path).unwrap())
    }

    #[test]
    fn mixed_identity_overlap_preserves_modified_legacy_annotations() {
        let source = game(None, "e4 e5", "edited by the user");
        let batch = game(Some("123"), "e4 e5", "provider annotation");
        let (result, bytes) = append_fixture(&source, &batch);
        assert_eq!(
            result.unwrap(),
            0,
            "a uniquely compatible legacy occurrence was appended twice"
        );
        assert_eq!(
            bytes,
            source.as_bytes(),
            "overlap replaced the user's annotations or custom headers"
        );
    }

    #[test]
    fn distinct_known_ids_with_identical_semantics_both_survive_and_retry_is_idempotent() {
        let source = game(Some("123"), "e4 e5", "first");
        let batch = game(Some("456"), "e4 e5", "second");
        let (result, bytes) = append_fixture(&source, &batch);
        assert_eq!(
            result.unwrap(),
            1,
            "different provider IDs collapsed by fingerprint"
        );
        let combined = String::from_utf8(bytes).unwrap();
        assert!(combined.starts_with(&source));
        assert!(combined.ends_with(&batch));
        let (result, retried) = append_fixture(&combined, &batch);
        assert_eq!(result.unwrap(), 0, "completed batch was appended again");
        assert_eq!(retried, combined.as_bytes());
    }

    #[test]
    fn ambiguous_legacy_multiplicity_requires_reconciliation_without_losing_versions() {
        let legacy = game(None, "e4 e5", "legacy");
        let (result, _) = append_fixture(
            &format!("{legacy}{legacy}"),
            &game(Some("123"), "e4 e5", "download"),
        );
        assert!(
            matches!(result, Err(Error::Conflict(_))),
            "ambiguous legacy identities were silently assigned"
        );
    }

    #[test]
    fn conflicting_known_id_and_missing_identity_fields_refuse_append() {
        let source = game(Some("123"), "e4 e5", "first");
        assert!(matches!(
            append_fixture(&source, &game(Some("123"), "d4 d5", "changed")).0,
            Err(Error::Conflict(_))
        ));
        let incomplete = game(None, "e4 e5", "legacy").replace("[UTCTime \"12:00:00\"]\n", "");
        assert!(matches!(
            append_fixture(&incomplete, &game(Some("123"), "e4 e5", "new")).0,
            Err(Error::Conflict(_))
        ));
    }

    #[test]
    fn mixed_known_and_legacy_source_occurrences_never_guess_a_new_id_assignment() {
        let source = format!(
            "{}{}",
            game(Some("123"), "e4 e5", "known"),
            game(None, "e4 e5", "legacy")
        );
        assert!(matches!(
            append_fixture(&source, &game(Some("456"), "e4 e5", "new ID")).0,
            Err(Error::Conflict(_))
        ));
        let duplicates = format!(
            "{}{}",
            game(None, "e4 e5", "one"),
            game(None, "e4 e5", "two")
        );
        let unrelated = game(Some("456"), "d4 d5", "unrelated");
        let (result, bytes) = append_fixture(&duplicates, &unrelated);
        assert_eq!(result.unwrap(), 1);
        assert!(bytes.starts_with(duplicates.as_bytes()));
    }

    #[test]
    fn identity_range_omits_two_games_and_accepts_one_game() {
        for (bytes, usable) in [
            (b"1. e4 *\n\n1. d4 *\n".as_slice(), false),
            (b"1. e4 *\n".as_slice(), true),
        ] {
            let range = pgn::GameRange {
                start: 0,
                end: bytes.len() as u64,
            };
            let (_, game) = identity_range(
                &mut std::io::Cursor::new(bytes),
                range,
                &CancellationToken::new(),
            )
            .unwrap();
            assert_eq!(game.is_some(), usable);
        }
    }
}
