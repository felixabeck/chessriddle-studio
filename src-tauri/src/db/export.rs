//! PGN export of a database.

use super::*;

pub(super) struct PgnGame {
    orientation: Option<String>,
    scoresheet_photos: Option<String>,
    event: Option<String>,
    site: Option<String>,
    date: Option<String>,
    time: Option<String>,
    round: Option<String>,
    white: Option<String>,
    black: Option<String>,
    result: Option<String>,
    time_control: Option<String>,
    eco: Option<String>,
    white_elo: Option<String>,
    black_elo: Option<String>,
    ply_count: Option<String>,
    fen: Option<String>,
    moves: Option<String>,
}

pub(super) fn write_decoded_pgn_tag(
    writer: &mut impl Write,
    name: &str,
    value: &str,
) -> Result<(), Error> {
    write!(writer, "[{name} \"")?;
    for character in value.chars() {
        if character == '\\' || character == '"' {
            writer.write_all(b"\\")?;
        }
        write!(writer, "{character}")?;
    }
    writeln!(writer, "\"]")?;
    Ok(())
}

impl PgnGame {
    fn write(&self, writer: &mut impl Write) -> Result<(), Error> {
        // Event, Site, Date, UTCTime, and Result retain RawHeader's escaped spelling in existing
        // databases. The fields written through write_decoded_pgn_tag were decoded on import.
        writeln!(
            writer,
            "[Event \"{}\"]",
            self.event.as_deref().unwrap_or("?")
        )?;
        writeln!(writer, "[Site \"{}\"]", self.site.as_deref().unwrap_or("?"))?;
        // f-20261115-07: an absent Date or Round (NULL or any d-20261102-06 marker) is written
        // as the PGN-standard unknown marker, which duplicate cleanup reads as absent.
        writeln!(
            writer,
            "[Date \"{}\"]",
            SignatureField::Date
                .normalize(&self.date)
                .as_deref()
                .unwrap_or(GameSignature::ABSENT_DATE)
        )?;
        if let Some(time) = self.time.as_deref() {
            if !time.is_empty() {
                writeln!(writer, "[UTCTime \"{}\"]", time)?;
            }
        }
        write_decoded_pgn_tag(
            writer,
            "Round",
            SignatureField::Round
                .normalize(&self.round)
                .as_deref()
                .unwrap_or("?"),
        )?;
        write_decoded_pgn_tag(writer, "White", self.white.as_deref().unwrap_or("?"))?;
        write_decoded_pgn_tag(writer, "Black", self.black.as_deref().unwrap_or("?"))?;
        writeln!(
            writer,
            "[Result \"{}\"]",
            self.result.as_deref().unwrap_or("*")
        )?;
        if let Some(time_control) = self.time_control.as_deref() {
            write_decoded_pgn_tag(writer, "TimeControl", time_control)?;
        }
        if let Some(eco) = self.eco.as_deref() {
            write_decoded_pgn_tag(writer, "ECO", eco)?;
        }
        if let Some(white_elo) = self.white_elo.as_deref() {
            if white_elo == "0" {
                writeln!(writer, "[WhiteElo \"-\"]")?;
            } else {
                writeln!(writer, "[WhiteElo \"{}\"]", white_elo)?;
            }
        }
        if let Some(black_elo) = self.black_elo.as_deref() {
            if black_elo == "0" {
                writeln!(writer, "[BlackElo \"-\"]")?;
            } else {
                writeln!(writer, "[BlackElo \"{}\"]", black_elo)?;
            }
        }
        if let Some(ply_count) = self.ply_count.as_deref() {
            writeln!(writer, "[PlyCount \"{}\"]", ply_count)?;
        }
        if let Some(fen) = self.fen.as_deref() {
            writeln!(writer, "[SetUp \"1\"]")?;
            write_decoded_pgn_tag(writer, "FEN", fen)?;
        }
        if let Some(orientation) = self.orientation.as_deref() {
            write_decoded_pgn_tag(writer, "Orientation", orientation)?;
        }
        if let Some(photos) = self
            .scoresheet_photos
            .as_deref()
            .and_then(crate::coach::scoresheet_photo_store::validate_scoresheet_photos_tag)
        {
            write_decoded_pgn_tag(
                writer,
                crate::coach::scoresheet_photo_store::SCORESHEET_PHOTOS_TAG,
                photos,
            )?;
        }
        writeln!(writer)?;
        if let Some(moves) = self.moves.as_deref() {
            if !moves.is_empty() {
                write!(writer, "{} ", moves)?;
            }
        }
        match self.result.as_deref() {
            Some("1-0") => writeln!(writer, "1-0"),
            Some("0-1") => writeln!(writer, "0-1"),
            Some("1/2-1/2") => writeln!(writer, "1/2-1/2"),
            _ => writeln!(writer, "*"),
        }?;
        writeln!(writer)?;
        Ok(())
    }
}

#[tauri::command]
#[specta::specta]
pub async fn export_to_pgn(
    file: DatabaseHandle,
    destination: FileWorkspaceHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), Error> {
    state
        .folder_switch
        .wait_for_migration(
            crate::infra::path_authority::FolderSwitchKind::Database,
            None,
        )
        .await?;
    let operation = state.operations.accept("export_to_pgn")?;
    let cancellation = operation.token();
    let authority = state.pgn_path_authority.clone();
    let repository = Arc::clone(&state.database_repository);
    crate::infra::operations::run_native_operation(operation, "export_to_pgn", async move {
        BLOCKING_GATEWAY
            .spawn_cancellable(cancellation, move |token| {
                export_to_pgn_blocking(&authority, &repository, file, destination, token)
            })
            .await
    })
    .await
}

pub(super) fn export_to_pgn_blocking(
    authority: &crate::infra::path_authority::SharedPathAuthority,
    repository: &DatabaseRepository,
    file: DatabaseHandle,
    destination: FileWorkspaceHandle,
    cancellation: &CancellationToken,
) -> Result<(), Error> {
    #[cfg(test)]
    database_command_checkpoint("export_to_pgn", &file);
    let target = resolve_database(authority, &file, PathOperation::DatabaseExport)?;
    let (mut resolved, snapshot) = authority.with_mut(|authority| {
        let resolved = authority.resolve(destination.path_ref(), PathOperation::WritePgn, &[])?;
        let snapshot = resolved.pgn_snapshot()?;
        Ok::<_, Error>((resolved, snapshot))
    })??;

    let collection_source = authority
        .collections()?
        .map(|service| service.export_snapshot(authority, &file, cancellation))
        .transpose()?
        .flatten();
    if authority
        .collections()?
        .map(|service| service.contains_source(&destination))
        .transpose()?
        .unwrap_or(false)
    {
        return Err(Error::Conflict(
            "choose an export destination outside active collections".into(),
        ));
    }
    let mut database_connection = if collection_source.is_none() {
        Some(get_db_or_create(
            repository,
            &target,
            Some(cancellation),
            authority,
            &file,
        )?)
    } else {
        None
    };

    let installed = resolved.replace_pgn_atomic(snapshot, cancellation, |_, temporary| {
        if let Some(source) = &collection_source {
            let mut bytes = source.file.try_clone()?;
            crate::pgn::copy_range(&mut bytes, temporary, 0, source.revision.size, cancellation)?;
            if source.current_revision()? != source.revision {
                return Err(Error::StaleGame);
            }
            return Ok(());
        }
        let db = &mut **database_connection
            .as_mut()
            .ok_or_else(|| Error::Conflict("database export source is unavailable".into()))?;
        stream_database_to_pgn(db, temporary, false, cancellation)
    })?;
    crate::infra::fs::require_durable(
        installed.outcome,
        crate::error::DurabilityStage::DatabasePgnReplacement,
    )
}

pub(super) fn stream_database_to_pgn<W: Write>(
    db: &mut SqliteConnection,
    destination: W,
    order_by_id: bool,
    cancellation: &CancellationToken,
) -> Result<(), Error> {
    let (white_players, black_players) = diesel::alias!(players as white, players as black);
    let base = games::table
        .inner_join(white_players.on(games::white_id.eq(white_players.field(players::id))))
        .inner_join(black_players.on(games::black_id.eq(black_players.field(players::id))))
        .inner_join(events::table.on(games::event_id.eq(events::id)))
        .inner_join(sites::table.on(games::site_id.eq(sites::id)));
    if scoresheet_photos_table_exists(db)? {
        let mut query = base
            .left_join(scoresheet_photos::table.on(games::id.eq(scoresheet_photos::game_id)))
            .select((
                games::all_columns,
                white_players.fields(players::all_columns),
                black_players.fields(players::all_columns),
                events::all_columns,
                sites::all_columns,
                scoresheet_photos::photos.nullable(),
            ))
            .into_boxed();
        if order_by_id {
            query = query.order(games::id.asc());
        }
        let rows = query
            .load_iter::<(Game, Player, Player, Event, Site, Option<String>), DefaultLoadingMode>(
                db,
            )?;
        write_pgn_rows_with_photos(destination, rows, cancellation)
    } else {
        let mut query = base.into_boxed();
        if order_by_id {
            query = query.order(games::id.asc());
        }
        let rows =
            query.load_iter::<(Game, Player, Player, Event, Site), DefaultLoadingMode>(db)?;
        write_pgn_rows(destination, rows, cancellation)
    }
}

pub(super) fn write_pgn_rows<W, I>(
    destination: W,
    rows: I,
    cancellation: &CancellationToken,
) -> Result<(), Error>
where
    W: Write,
    I: IntoIterator<Item = diesel::QueryResult<(Game, Player, Player, Event, Site)>>,
{
    write_pgn_rows_with_photos(
        destination,
        rows.into_iter().map(|row| {
            row.map(|(game, white, black, event, site)| (game, white, black, event, site, None))
        }),
        cancellation,
    )
}

pub(super) fn write_pgn_rows_with_photos<W, I>(
    destination: W,
    rows: I,
    cancellation: &CancellationToken,
) -> Result<(), Error>
where
    W: Write,
    I: IntoIterator<
        Item = diesel::QueryResult<(Game, Player, Player, Event, Site, Option<String>)>,
    >,
{
    let mut writer = BufWriter::new(destination);
    let mut rows = rows.into_iter();
    loop {
        if cancellation.is_cancelled() {
            return Err(Error::Cancellation);
        }
        let Some(row) = rows.next() else { break };
        #[cfg(test)]
        EXPORT_ROW_COUNT.with(|counter| {
            if let Some(counter) = counter.borrow().as_ref() {
                counter.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            }
        });
        #[cfg(test)]
        if let Some(block) = take_export_write_block() {
            block.entered.wait();
            block.release.wait();
        }
        let (game, white, black, event, site, scoresheet_photos) = row.map_err(Error::from)?;
        let initial_fen = game
            .fen
            .as_deref()
            .map(|fen| {
                Fen::from_ascii(fen.as_bytes()).map_err(|error| {
                    Error::InvalidInput(format!("game {} has invalid FEN: {error}", game.id))
                })
            })
            .transpose()?
            .unwrap_or_default();
        let moves = decode_game_to_movetext(&game.moves, initial_fen).map_err(|error| {
            Error::InvalidInput(format!("game {} has invalid movetext: {error}", game.id))
        })?;
        PgnGame {
            orientation: game.orientation,
            scoresheet_photos,
            event: event
                .name
                .filter(|name| event.id != 0 && database_index_name(Some(name)).is_some()),
            site: site
                .name
                .filter(|name| site.id != 0 && database_index_name(Some(name)).is_some()),
            date: game.date,
            time: game.time,
            round: game.round,
            white: white
                .name
                .filter(|name| white.id != 0 && database_index_name(Some(name)).is_some()),
            black: black
                .name
                .filter(|name| black.id != 0 && database_index_name(Some(name)).is_some()),
            result: game.result,
            time_control: game.time_control,
            eco: game.eco,
            white_elo: game.white_elo.map(|elo| elo.to_string()),
            black_elo: game.black_elo.map(|elo| elo.to_string()),
            ply_count: game.ply_count.map(|count| count.to_string()),
            fen: game.fen,
            moves: Some(moves),
        }
        .write(&mut writer)?;
    }
    writer.flush()?;
    Ok(())
}

#[cfg(test)]
pub(super) struct ExportWriteBlock {
    pub(super) entered: std::sync::Barrier,
    pub(super) release: std::sync::Barrier,
}

#[cfg(test)]
std::thread_local! {
    pub(super) static EXPORT_WRITE_BLOCK: std::cell::RefCell<Option<Arc<ExportWriteBlock>>> = const {
        std::cell::RefCell::new(None)
    };
    pub(super) static EXPORT_ROW_COUNT: std::cell::RefCell<Option<Arc<std::sync::atomic::AtomicUsize>>> = const {
        std::cell::RefCell::new(None)
    };
}

#[cfg(test)]
pub(super) fn take_export_write_block() -> Option<Arc<ExportWriteBlock>> {
    EXPORT_WRITE_BLOCK.with(|block| block.borrow_mut().take())
}
