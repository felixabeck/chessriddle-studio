//! PGN import, account import and search-index generation commands.

use super::*;

#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)] // IPC contract is generated and intentionally stable.
pub async fn convert_pgn(
    progress_id: String,
    files: Vec<FileWorkspaceHandle>,
    database: DatabaseHandle,
    app: tauri::AppHandle,
    title: String,
    description: Option<String>,
    ticket: Option<String>,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> Result<(), Error> {
    convert_pgn_command_core(
        progress_id,
        files,
        database,
        app,
        title,
        description,
        ticket.as_deref(),
        window.label(),
        &state,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn convert_pgn_command_core<R: tauri::Runtime>(
    progress_id: String,
    files: Vec<FileWorkspaceHandle>,
    database: DatabaseHandle,
    app: tauri::AppHandle<R>,
    title: String,
    description: Option<String>,
    ticket: Option<&str>,
    owner: &str,
    state: &AppState,
) -> Result<(), Error> {
    crate::wait_for_reserved_migration(
        state,
        crate::infra::path_authority::FolderSwitchKind::Database,
        ticket,
        owner,
        crate::infra::operations::ReservationKind::Conversion,
    )
    .await?;
    let operation = match ticket {
        Some(ticket) => state.operations.claim_conversion(ticket, owner)?,
        None => state.operations.accept("convert_pgn")?,
    };
    let cancellation = operation.token();
    let authority = state.pgn_path_authority.clone();
    let repository = Arc::clone(&state.database_repository);
    let search_cache = Arc::clone(&state.search_cache);
    crate::infra::operations::run_native_operation(operation, "convert_pgn", async move {
        BLOCKING_GATEWAY
            .spawn_cancellable(cancellation, move |token| {
                convert_pgn_blocking(
                    &authority,
                    &repository,
                    &search_cache,
                    files,
                    database,
                    None,
                    app,
                    title,
                    description,
                    progress_id,
                    token,
                )
            })
            .await
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub fn prepare_conversion(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> Result<String, Error> {
    state.operations.prepare_conversion(window.label())
}

#[tauri::command]
#[specta::specta]
pub fn cancel_conversion(
    ticket: String,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> Result<bool, Error> {
    state.operations.cancel_conversion(&ticket, window.label())
}

#[tauri::command]
#[specta::specta]
pub fn release_conversion(
    ticket: String,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> Result<(), Error> {
    state.operations.release_conversion(&ticket, window.label())
}

#[derive(Default)]
pub(super) struct ImportFileContext {
    pub(super) capability_id: Option<String>,
    pub(super) display_name: Option<String>,
    pub(super) game: usize,
    pub(super) source: SourceReadState,
    pub(super) parser_diagnostic: Option<String>,
}

impl ImportFileContext {
    pub(super) fn run(
        &mut self,
        work: impl FnOnce(&mut Self) -> Result<(), Error>,
    ) -> Result<(), Error> {
        let result = work(self);
        if let Err(error) = &result {
            if matches!(error, Error::Cancellation | Error::AnalysisCancelled) {
                return result;
            }
            let diagnostic = error.diagnostic();
            let diagnostic = match &self.parser_diagnostic {
                Some(cause) => format!("{diagnostic}; parser cause: {cause}"),
                None => diagnostic,
            };
            log::error!(
                "PGN import failed capability_id={:?} file={:?} game={} decompressed_offset={}: {}",
                self.capability_id,
                self.display_name.as_deref().unwrap_or("unknown PGN"),
                self.game,
                self.source.bytes_read.get(),
                diagnostic,
            );
        }
        result
    }
}

pub(crate) struct AccountImportContext {
    pub identity: linked_collections::AccountIdentity,
    pub since_ms: Option<i64>,
    pub coverage_holds: Option<Vec<crate::lichess::CoverageHold>>,
    pub coverage_floor_ms: Option<i64>,
}

pub(super) struct AccountImporter {
    context: AccountImportContext,
    newest_start_ms: Option<i64>,
    provider_ids: std::collections::HashSet<String>,
}

#[derive(QueryableByName)]
pub(super) struct AccountGameId {
    #[diesel(sql_type = diesel::sql_types::Integer)]
    game_id: i32,
}

impl AccountImporter {
    pub(super) fn new(
        db: &mut SqliteConnection,
        context: AccountImportContext,
        cancellation: &CancellationToken,
    ) -> Result<Self, Error> {
        db.batch_execute(
            "CREATE TABLE IF NOT EXISTS AccountProviderGames (
                Provider TEXT NOT NULL,
                ProviderGameID TEXT NOT NULL,
                GameID INTEGER NOT NULL UNIQUE REFERENCES Games(ID) ON DELETE CASCADE,
                PRIMARY KEY (Provider, ProviderGameID)
            );
            CREATE TEMP TABLE IF NOT EXISTS AccountFingerprints (
                GameID INTEGER PRIMARY KEY, Fingerprint TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS temp.AccountFingerprintLookup ON AccountFingerprints(Fingerprint);
            DELETE FROM temp.AccountFingerprints;",
        )?;
        // Bound the decoded row batch. Membership stays in SQLite instead of retaining every
        // stored game's moves in memory while replaying a full-history legacy sync.
        let mut after = -1;
        loop {
            cancellation_check(cancellation)?;
            let (white, black) = diesel::alias!(players as account_white, players as account_black);
            let rows: Vec<(Game, Player, Player)> = games::table
                .inner_join(white.on(games::white_id.eq(white.field(players::id))))
                .inner_join(black.on(games::black_id.eq(black.field(players::id))))
                .select((
                    games::all_columns,
                    white.fields(players::all_columns),
                    black.fields(players::all_columns),
                ))
                .filter(games::id.gt(after))
                .order(games::id.asc())
                .limit(ACCOUNT_IMPORT_BATCH_ROW_LIMIT)
                .load(db)?;
            if rows.is_empty() {
                break;
            }
            for (game, white, black) in rows {
                cancellation_check(cancellation)?;
                after = game.id;
                let stored = TempGame {
                    white_name: white
                        .name
                        .filter(|name| white.id != 0 && database_index_name(Some(name)).is_some()),
                    black_name: black
                        .name
                        .filter(|name| black.id != 0 && database_index_name(Some(name)).is_some()),
                    date: game.date,
                    time: game.time,
                    fen: game.fen,
                    moves: game.moves,
                    ..Default::default()
                };
                Self::remember(
                    db,
                    game.id,
                    &linked_collections::semantic_fingerprint(&stored, &context.identity),
                )?;
            }
        }
        Ok(Self {
            context,
            newest_start_ms: None,
            provider_ids: Default::default(),
        })
    }

    pub(super) fn remember(
        db: &mut SqliteConnection,
        game_id: i32,
        fingerprint: &str,
    ) -> Result<(), Error> {
        sql_query("INSERT INTO temp.AccountFingerprints (GameID, Fingerprint) VALUES (?, ?)")
            .bind::<diesel::sql_types::Integer, _>(game_id)
            .bind::<Text, _>(fingerprint)
            .execute(db)?;
        Ok(())
    }

    pub(super) fn insert(
        &mut self,
        db: &mut SqliteConnection,
        mut game: TempGame,
    ) -> Result<bool, Error> {
        if database_index_name(game.white_name.as_deref()).is_none() {
            game.white_name = None;
        }
        if database_index_name(game.black_name.as_deref()).is_none() {
            game.black_name = None;
        }
        let start = game
            .date
            .as_ref()
            .zip(game.time.as_ref())
            .and_then(|(date, time)| {
                Some(
                    NaiveDate::parse_from_str(date, "%Y.%m.%d")
                        .ok()?
                        .and_time(NaiveTime::parse_from_str(time, "%H:%M:%S").ok()?)
                        .and_utc()
                        .timestamp_millis(),
                )
            });
        self.newest_start_ms = self.newest_start_ms.into_iter().chain(start).max();
        let identity = &self.context.identity;
        let id = linked_collections::provider_game_id(&game.provider_headers, identity)?;
        let fingerprint = linked_collections::semantic_fingerprint(&game, identity);
        let mut inserted = false;
        if let Some(id) = id {
            self.provider_ids.insert(id.clone());
            let known = sql_query("SELECT GameID AS game_id FROM AccountProviderGames WHERE Provider = ? AND ProviderGameID = ?")
                .bind::<Text, _>(&identity.provider)
                .bind::<Text, _>(&id)
                .get_result::<AccountGameId>(db).optional()?;
            if known.is_some() {
                return Ok(false);
            }
            let legacy = sql_query("SELECT f.GameID AS game_id FROM temp.AccountFingerprints f WHERE f.Fingerprint = ? AND NOT EXISTS (SELECT 1 FROM AccountProviderGames p WHERE p.GameID = f.GameID) ORDER BY f.GameID LIMIT 1")
                .bind::<Text, _>(&fingerprint)
                .get_result::<AccountGameId>(db).optional()?;
            let game_id = match legacy {
                Some(row) => row.game_id,
                None => {
                    let game_id = game.insert_to_db(db)?;
                    Self::remember(db, game_id, &fingerprint)?;
                    inserted = true;
                    game_id
                }
            };
            sql_query("INSERT INTO AccountProviderGames (Provider, ProviderGameID, GameID) VALUES (?, ?, ?)")
                .bind::<Text, _>(&identity.provider)
                .bind::<Text, _>(id)
                .bind::<diesel::sql_types::Integer, _>(game_id)
                .execute(db)?;
        } else {
            let known = sql_query("SELECT GameID AS game_id FROM temp.AccountFingerprints WHERE Fingerprint = ? LIMIT 1")
                .bind::<Text, _>(&fingerprint)
                .get_result::<AccountGameId>(db).optional()?;
            if known.is_none() {
                let game_id = game.insert_to_db(db)?;
                Self::remember(db, game_id, &fingerprint)?;
                inserted = true;
            }
        }
        Ok(inserted)
    }

    fn finish(self, db: &mut SqliteConnection) -> Result<(), Error> {
        let cursor = linked_collections::account_sync_cursor(
            &self.context.identity.provider,
            self.context.since_ms,
            self.newest_start_ms,
            &self.provider_ids,
            self.context.coverage_holds.as_deref(),
            self.context.coverage_floor_ms,
        );
        let stored = stored_account_sync_cursor(db)?;
        if linked_collections::coverage_cursor_advances_without_gap(self.context.since_ms, stored) {
            update_info_count(db, "AccountSyncCursor", cursor)?;
        }
        db.batch_execute("DELETE FROM temp.AccountFingerprints;")?;
        Ok(())
    }
}

pub(super) fn stored_account_sync_cursor(db: &mut SqliteConnection) -> Result<Option<i64>, Error> {
    let value = info::table
        .filter(info::name.eq("AccountSyncCursor"))
        .select(info::value)
        .first::<Option<String>>(db)
        .optional()?
        .flatten();
    value
        .map(|value| {
            value
                .parse::<i64>()
                .ok()
                .filter(|value| *value >= 0)
                .ok_or_else(|| Error::InvalidInput("invalid account sync cursor".into()))
        })
        .transpose()
}

pub(crate) fn account_sync_cursor_blocking(
    authority: &crate::infra::path_authority::SharedPathAuthority,
    repository: &DatabaseRepository,
    database: &DatabaseHandle,
    cancellation: &CancellationToken,
) -> Result<Option<i64>, Error> {
    let target = resolve_database(authority, database, PathOperation::DatabaseCreate)?;
    repository.with_write_lock_cancellable(&target, cancellation, || {
        repository.ensure_schema_if_initialized(&target, cancellation)?;
        let mut connection = repository.initialization_connection(&target, Some(cancellation))?;
        // New account targets are empty files. Reading their cursor must not initialize them
        // outside the eventual import transaction.
        #[derive(QueryableByName)]
        struct Count {
            #[diesel(sql_type = diesel::sql_types::BigInt)]
            count: i64,
        }
        let tables = sql_query("SELECT count(*) AS count FROM sqlite_master WHERE type = 'table'")
            .get_result::<Count>(&mut *connection)?
            .count;
        if tables == 0 {
            return Ok(None);
        }
        migrations::check_current_database(&mut connection)?;
        stored_account_sync_cursor(&mut connection)
    })
}

pub(super) fn read_import_games(
    source: impl std::io::Read,
    context: &mut ImportFileContext,
    account: Option<&linked_collections::AccountIdentity>,
    cancellation: &CancellationToken,
    mut insert: impl FnMut(TempGame) -> Result<(), Error>,
) -> Result<(), Error> {
    let mut importer = Importer::new(account);
    let mut reader = BufferedReader::new(CancellableRead::new(
        SourceRead::new(source, &context.source),
        cancellation,
    ));
    loop {
        context.source.failed.set(false);
        let parsed = reader.read_game(&mut importer);
        context.game = importer.games_started;
        let parsed = parsed.map_err(|error| {
            match map_read_error(error, cancellation) {
                Error::Cancellation => Error::Cancellation,
                Error::Io(error) if context.source.failed.get() => Error::Io(error),
                error => {
                    // Preserve the parser cause locally before replacing the wire message.
                    context.parser_diagnostic = Some(error.diagnostic());
                    Error::InvalidInput(format!(
                        "{}: game {} could not be read (unterminated comment or tag)",
                        context.display_name.as_deref().unwrap_or("unknown PGN"),
                        context.game,
                    ))
                }
            }
        })?;
        let Some(parsed_game) = parsed else {
            return Ok(());
        };
        cancellation_check(cancellation)?;
        if let Some(game) = parsed_game {
            insert(game)?;
        }
    }
}

// Individual Arc handles the closure must own: BlockingGateway::spawn is
// `'static` and AppState is not Clone. A bundle type was rejected (plan
// decision D-B).
#[allow(clippy::too_many_arguments)]
pub(crate) fn convert_pgn_blocking<R: tauri::Runtime>(
    authority: &crate::infra::path_authority::SharedPathAuthority,
    repository: &DatabaseRepository,
    search_cache: &SearchCache,
    files: Vec<FileWorkspaceHandle>,
    database: DatabaseHandle,
    account: Option<AccountImportContext>,
    app: tauri::AppHandle<R>,
    title: String,
    description: Option<String>,
    progress_id: String,
    cancellation: &CancellationToken,
) -> Result<(), Error> {
    convert_sources_blocking(
        authority,
        repository,
        search_cache,
        files.into_iter().map(ImportSource::Workspace).collect(),
        database,
        account,
        app,
        title,
        description,
        progress_id,
        cancellation,
        |_| Ok(()),
    )
    .map(|_| ())
}

/// Where an import reads one PGN from.
pub(crate) enum ImportSource {
    /// A workspace file, resolved and opened through the path authority.
    Workspace(FileWorkspaceHandle),
    /// An open file the caller owns, read from its current position as plain PGN. `name` labels
    /// it in progress and diagnostics.
    Staged { name: String, file: std::fs::File },
}

/// Imports every source into `database` in one transaction. `after_import` runs inside that
/// transaction once all games are in, so a failure there rolls the import back with it. Returns
/// the games imported per source and `after_import`'s value, or `None` without sources.
#[allow(clippy::too_many_arguments)]
pub(crate) fn convert_sources_blocking<R: tauri::Runtime, T>(
    authority: &crate::infra::path_authority::SharedPathAuthority,
    repository: &DatabaseRepository,
    search_cache: &SearchCache,
    files: Vec<ImportSource>,
    database: DatabaseHandle,
    account: Option<AccountImportContext>,
    app: tauri::AppHandle<R>,
    title: String,
    description: Option<String>,
    progress_id: String,
    cancellation: &CancellationToken,
    after_import: impl FnOnce(&mut SqliteConnection) -> Result<T, Error>,
) -> Result<Option<(Vec<usize>, T)>, Error> {
    #[cfg(test)]
    database_command_checkpoint("convert_pgn", &database);
    let target = resolve_database(authority, &database, PathOperation::DatabaseCreate)?;

    if files.is_empty() {
        return Ok(None);
    }
    let mut per_source = vec![0usize; files.len()];
    let mut after_value = None;

    let description = description.unwrap_or_default();
    let start = Instant::now();
    let mut imported_games = 0usize;
    let mut content_validated = false;
    let result = repository.with_write_lock_cancellable(&target, cancellation, || {
        guard_database_mutation(authority, &database, PathOperation::DatabaseCreate)?;
        repository.ensure_schema_if_initialized(&target, cancellation)?;
        if let Some(collections) = authority.collections()? {
            for source in &files {
                if let ImportSource::Workspace(source) = source {
                    collections.guard_conversion_source(authority, source, cancellation)?;
                }
            }
        }
        let mut database_connection =
            repository.initialization_connection(&target, Some(cancellation))?;
        let db = &mut *database_connection;
        db.transaction::<_, Error, _>(|db| {
            bump_revision_in_transaction(db, target.path(), cancellation, |db| {
                let (database_was_created, validated) =
                    migrations::prepare_database_with_validation(db, &title, &description)?;
                content_validated = validated;
                let mut account_import = account
                    .map(|account| AccountImporter::new(db, account, cancellation))
                    .transpose()?;

                for (source_index, source) in files.into_iter().enumerate() {
                    let mut context = ImportFileContext {
                        capability_id: match &source {
                            ImportSource::Workspace(handle) => Some(handle.path_ref().id.clone()),
                            ImportSource::Staged { .. } => None,
                        },
                        ..Default::default()
                    };
                    context.run(|context| {
                        cancellation_check(cancellation)?;
                        let uncompressed: Box<dyn std::io::Read + Send> = match source {
                            ImportSource::Workspace(file_handle) => {
                                let file = authority.with_mut(|authority| {
                                    context.display_name =
                                        Some(authority.display_name(file_handle.path_ref())?);
                                    let resolved = authority.resolve(
                                        file_handle.path_ref(),
                                        PathOperation::ReadPgn,
                                        &[],
                                    )?;
                                    resolved.into_read_file()
                                })??;
                                decompressing_reader(context.display_name.as_deref(), file)?
                            }
                            ImportSource::Staged { name, file } => {
                                context.display_name = Some(name);
                                Box::new(file)
                            }
                        };
                        let current_file_name = context.display_name.clone();

                        let identity = account_import
                            .as_ref()
                            .map(|importer| importer.context.identity.clone());
                        read_import_games(
                            uncompressed,
                            context,
                            identity.as_ref(),
                            cancellation,
                            |game| {
                                let inserted = match account_import.as_mut() {
                                    Some(importer) => importer.insert(db, game)?,
                                    None => {
                                        game.insert_to_db(db)?;
                                        true
                                    }
                                };
                                if !inserted {
                                    return Ok(());
                                }
                                if imported_games.is_multiple_of(1000) {
                                    let _ = ConvertProgress {
                                        id: progress_id.clone(),
                                        imported_games: imported_games as u32,
                                        elapsed_ms: start.elapsed().as_millis() as u32,
                                        source_file_name: current_file_name.clone(),
                                    }
                                    .emit(&app);
                                }
                                imported_games += 1;
                                per_source[source_index] += 1;
                                Ok(())
                            },
                        )
                    })?;
                }

                if let Some(importer) = account_import {
                    importer.finish(db)?;
                }

                if database_was_created {
                    create_required_indexes(db)?;
                }
                after_value = Some(after_import(db)?);
                refresh_derived_database_data(db)?;
                #[cfg(test)]
                CONVERSION_BEFORE_REVISION.run(&progress_id);
                Ok(())
            })
        })?;
        if content_validated {
            content_validation::publish_committed_pass(repository, authority, &database, &target);
        }
        Ok(())
    });
    finish_search_cache_after_transaction(result, search_cache, &target)?;

    #[cfg(test)]
    CONVERSION_AFTER_COMMIT.run(&progress_id);

    let _ = ConvertProgress {
        id: progress_id,
        imported_games: imported_games as u32,
        elapsed_ms: start.elapsed().as_millis() as u32,
        source_file_name: None,
    }
    .emit(&app);
    Ok(after_value.map(|value| (per_source, value)))
}

pub(super) fn decompressing_reader<R: std::io::Read + Send + 'static>(
    display_name: Option<&str>,
    file: R,
) -> std::io::Result<Box<dyn std::io::Read + Send>> {
    let extension = display_name
        .and_then(|name| std::path::Path::new(name).extension())
        .and_then(OsStr::to_str)
        .map(str::to_ascii_lowercase);
    match extension.as_deref() {
        Some("bz2") => Ok(Box::new(bzip2::read::MultiBzDecoder::new(file))),
        Some("zst") => Ok(Box::new(zstd::Decoder::new(file)?)),
        _ => Ok(Box::new(file)),
    }
}

pub fn generate_search_index(
    handle: &DatabaseHandle,
    authority: &crate::infra::path_authority::SharedPathAuthority,
    repository: &DatabaseRepository,
    search_cache: &SearchCache,
    cancellation: &CancellationToken,
) -> Result<(), Error> {
    cancellation_check(cancellation)?;
    let linked = authority
        .collections()?
        .map(|service| service.is_linked(handle))
        .transpose()?
        .unwrap_or(false);
    if let Some(service) = authority.collections()? {
        service.resolve_database(authority, handle, PathOperation::DatabaseRead, cancellation)?;
    }
    let target = resolve_database(
        authority,
        handle,
        if linked {
            PathOperation::DatabaseRead
        } else {
            PathOperation::DatabaseMutate
        },
    )?;
    info!("Preparing search index for {:?}", target.path());
    repository.with_write_lock_cancellable(&target, cancellation, || {
        guard_database_mutation(
            authority,
            handle,
            if linked {
                PathOperation::DatabaseRead
            } else {
                PathOperation::DatabaseMutate
            },
        )?;
        repository.with_index_lock_cancellable(&target, cancellation, || {
            generate_search_index_locked(
                &target,
                repository,
                search_cache,
                cancellation,
                authority,
                handle,
            )
        })
    })
}

#[derive(Queryable)]
pub(super) struct SearchIndexGameRecord {
    id: i32,
    white_id: i32,
    black_id: i32,
    date: Option<String>,
    result: Option<String>,
    moves: Vec<u8>,
    fen: Option<String>,
    pawn_home: i32,
    white_material: i32,
    black_material: i32,
    white_elo: Option<i32>,
    black_elo: Option<i32>,
}

pub(super) fn generate_search_index_locked(
    target: &DatabaseFileTarget,
    repository: &DatabaseRepository,
    search_cache: &SearchCache,
    cancellation: &CancellationToken,
    authority: &crate::infra::path_authority::SharedPathAuthority,
    file: &DatabaseHandle,
) -> Result<(), Error> {
    cancellation_check(cancellation)?;
    let linked = authority
        .collections()?
        .map(|service| service.is_linked(file))
        .transpose()?
        .unwrap_or(false);
    let mut database_connection = if linked {
        repository.connection(target, Some(cancellation))?
    } else {
        get_db_or_create(repository, target, Some(cancellation), authority, file)?
    };
    let db = &mut *database_connection;
    let index_leaf = search_index::preferred_sidecar_leaf(target.leaf());

    info!("Generating search index for {:?}", target.path());
    let start = Instant::now();

    let source = IndexSource::from_database_identity(&repository.database_identity_expected(
        target,
        target.identity(),
        Some(cancellation),
    )?)?;
    let outcome = sqlite_cancellation::with_sqlite_cancellation(cancellation, || {
        let rows = games::table
            .select((
                games::id,
                games::white_id,
                games::black_id,
                games::date,
                games::result,
                games::moves,
                games::fen,
                games::pawn_home,
                games::white_material,
                games::black_material,
                games::white_elo,
                games::black_elo,
            ))
            .load_iter::<SearchIndexGameRecord, DefaultLoadingMode>(db)?
            .map(|row| {
                cancellation_check(cancellation)?;
                let game = row.map_err(Error::from)?;
                SearchGameEntry::from_game_data_cancellable(
                    crate::db::search_index::SearchGameData {
                        id: game.id,
                        white_id: game.white_id,
                        black_id: game.black_id,
                        date: game.date,
                        result: game.result,
                        moves: game.moves,
                        fen: game.fen,
                        pawn_home: game.pawn_home,
                        white_material: game.white_material,
                        black_material: game.black_material,
                        white_elo: game.white_elo,
                        black_elo: game.black_elo,
                    },
                    cancellation,
                )
            });
        search_cache.invalidate_database(target);
        search_index::write_entries_to_at(target.parent(), &index_leaf, source, rows, cancellation)
    })?;
    // Publication has committed once `write_entries_to_at` returns. From here on the durability
    // and cache-invalidation tail must finish even if cancellation arrives concurrently.
    let durability = crate::infra::fs::require_durable(
        outcome,
        crate::error::DurabilityStage::SearchIndexReplacement,
    );
    search_cache.invalidate_database(target);
    durability?;

    info!("Search index generated in {:?}", start.elapsed());
    Ok(())
}

/// Import progress for a PGN-to-database conversion. A conversion has no total
/// to divide by until it finishes, so this reports the counters the UI shows
/// rather than a percentage.
#[derive(Serialize, Deserialize, Debug, Clone, Type, tauri_specta::Event)]
pub struct ConvertProgress {
    pub id: String,
    pub imported_games: u32,
    pub elapsed_ms: u32,
    pub source_file_name: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Type, tauri_specta::Event)]
pub struct DatabaseContentFailure {
    pub filename: String,
    pub message: String,
}

#[cfg(test)]
mod migration_gate_tests {
    use super::*;
    use crate::infra::path_authority::{
        DatabaseHandle, FolderSwitchKind, LegacyMigrationCandidate, PathAuthority, PathRef,
        SharedPathAuthority,
    };
    use std::collections::HashSet;
    use std::time::Duration;

    #[tokio::test]
    async fn convert_pgn_parked_past_shortened_ttl_still_claims_and_wakes_on_cancel() {
        let dir = tempfile::tempdir().unwrap();
        let authority = SharedPathAuthority::installed(
            PathAuthority::open(dir.path().join("auth.json"), vec![]).unwrap(),
        );
        let app = tauri::test::mock_app();
        let state = AppState {
            pgn_path_authority: authority,
            operations: crate::infra::operations::OperationRegistry::with_reservation_ttl(
                Duration::from_millis(40),
            ),
            ..AppState::default()
        };

        let mut gates = state
            .folder_switch
            .raise_migration_gates(vec![LegacyMigrationCandidate {
                kind: FolderSwitchKind::Database,
                source_root: PathRef {
                    id: "conv-ttl".into(),
                },
                source_identity: (61, 62),
                source_path: dir.path().join("legacy-db"),
                engine_descendants: HashSet::new(),
            }]);
        let (_, gate) = gates.pop().unwrap();

        let cancel_ticket = state.operations.prepare_conversion("main").unwrap();
        let claim_ticket = state.operations.prepare_conversion("main").unwrap();

        let s1 = state.clone();
        let a1 = app.handle().clone();
        let t1 = cancel_ticket.clone();
        let cancel_task = tokio::spawn(async move {
            convert_pgn_command_core(
                "conv-cancel".into(),
                vec![],
                DatabaseHandle::new(PathRef {
                    id: "dummy-db".into(),
                }),
                a1,
                "Test".into(),
                None,
                Some(&t1),
                "main",
                &s1,
            )
            .await
        });

        let s2 = state.clone();
        let a2 = app.handle().clone();
        let t2 = claim_ticket.clone();
        let claim_task = tokio::spawn(async move {
            convert_pgn_command_core(
                "conv-claim".into(),
                vec![],
                DatabaseHandle::new(PathRef {
                    id: "dummy-db".into(),
                }),
                a2,
                "Test".into(),
                None,
                Some(&t2),
                "main",
                &s2,
            )
            .await
        });

        // Wait past the 40ms reservation TTL and trigger `purge_expired`.
        tokio::time::sleep(Duration::from_millis(80)).await;
        let _trigger = state.operations.prepare_conversion("main").unwrap();

        assert!(
            !cancel_task.is_finished(),
            "convert_pgn_command_core must stay parked past TTL"
        );
        assert!(
            !claim_task.is_finished(),
            "convert_pgn_command_core must stay parked past TTL"
        );

        // 1. `cancel_conversion` wakes the parked conversion with `Error::Cancellation`.
        state
            .operations
            .cancel_conversion(&cancel_ticket, "main")
            .unwrap();
        let cancel_res = tokio::time::timeout(Duration::from_secs(2), cancel_task)
            .await
            .expect("cancel_conversion must wake parked convert_pgn_command_core")
            .unwrap();
        assert!(
            matches!(cancel_res, Err(Error::Cancellation)),
            "expected Error::Cancellation, got {cancel_res:?}"
        );

        // 2. Releasing the Database gate lets the second conversion claim its ticket past TTL
        // (must NOT fail with "conversion reservation is unknown or expired").
        gate.release();
        let claim_res = tokio::time::timeout(Duration::from_secs(5), claim_task)
            .await
            .expect("releasing Database gate must wake parked convert_pgn_command_core")
            .unwrap();
        match claim_res {
            Ok(()) => {}
            Err(Error::Conflict(msg)) if msg.contains("reservation") => {
                panic!("parked conversion ticket expired past shortened TTL: {msg}");
            }
            Err(_) => {
                // Claim succeeded; downstream empty-file/dummy-db handling returned its own error.
            }
        }
    }
}
