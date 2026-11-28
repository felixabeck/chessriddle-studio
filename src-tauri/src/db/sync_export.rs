//! Cheap read-only metadata probe and bounded deterministic PGN export for sync callers.
// Temporary until Phase 2 wires `library_sync` callers to these helpers.
#![cfg_attr(not(test), allow(dead_code))]

use std::io::Write;

use diesel::{
    prelude::*,
    sql_query,
    sql_types::{BigInt, Nullable, Text},
    SqliteConnection,
};
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

use crate::{
    db::{DatabaseIdentity, DatabaseRepository},
    error::Error,
    infra::path_authority::DatabaseFileTarget,
};

#[derive(QueryableByName)]
struct CountRow {
    #[diesel(sql_type = BigInt)]
    count: i64,
}

#[derive(QueryableByName)]
struct InfoEntryRow {
    #[diesel(sql_type = Text)]
    name: String,
    #[diesel(sql_type = Nullable<Text>)]
    value: Option<String>,
}

struct RawCheapInfo {
    title: Option<String>,
    game_count: u64,
}

/// Result of a cheap read-only Info probe that never enters schema upgrades or `validate_content`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum CheapDatabaseInfo {
    Eligible {
        identity: DatabaseIdentity,
        /// Non-blank trimmed `Info.Title`, or `None` when missing/blank so callers can fall back.
        title: Option<String>,
        game_count: u64,
    },
    Empty {
        identity: DatabaseIdentity,
        title: Option<String>,
    },
    TooManyGames {
        identity: DatabaseIdentity,
        title: Option<String>,
        game_count: u64,
    },
    /// Transient contention (`is_database_busy()` or any `Error::Conflict`); retry on next scan.
    Deferred,
    /// Corrupt, non-SQLite, or uninitialized database.
    Unreadable,
}

/// Result of a bounded deterministic PGN export (`order_by_id = true`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum BoundedDatabaseExport {
    Exported {
        bytes: Vec<u8>,
        sha256: String,
    },
    Empty,
    TooManyGames,
    TooLarge,
    /// Per-game invalid FEN or movetext encountered during export.
    InvalidPgn,
    /// Transient contention (`is_database_busy()` or any `Error::Conflict`); retry on next scan.
    Deferred,
    /// Corrupt, non-SQLite, or uninitialized database.
    Unreadable,
}

/// Returns true for transient database contention or conflict errors that should defer rather than
/// mark a database permanently unreadable.
pub(crate) fn is_deferred_database_error(error: &Error) -> bool {
    error.is_database_busy() || matches!(error.unlabelled(), Error::Conflict(_))
}

/// Streaming writer that enforces a hard byte cap and hashes accepted bytes with SHA-256.
/// Once the cap would be exceeded, it marks overflow, discards buffered bytes, and returns an I/O
/// error so the caller stops immediately without buffering the rest of the stream.
struct BoundedHashWriter {
    max_bytes: u64,
    written: u64,
    overflowed: bool,
    hasher: Sha256,
    buffer: Vec<u8>,
}

impl BoundedHashWriter {
    fn new(max_bytes: u64) -> Self {
        Self {
            max_bytes,
            written: 0,
            overflowed: false,
            hasher: Sha256::new(),
            buffer: Vec::new(),
        }
    }

    fn overflowed(&self) -> bool {
        self.overflowed
    }

    fn written_bytes(&self) -> u64 {
        self.written
    }

    fn finish(self) -> (Vec<u8>, String) {
        let sha256 = format!("{:x}", self.hasher.finalize());
        (self.buffer, sha256)
    }
}

impl Write for BoundedHashWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        if self.overflowed {
            return Err(std::io::Error::other("exported PGN exceeds byte limit"));
        }
        let remaining = self.max_bytes.saturating_sub(self.written);
        if (buf.len() as u64) > remaining {
            self.overflowed = true;
            self.buffer.clear();
            self.buffer.shrink_to_fit();
            return Err(std::io::Error::other("exported PGN exceeds byte limit"));
        }
        self.written += buf.len() as u64;
        self.hasher.update(buf);
        self.buffer.extend_from_slice(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        if self.overflowed {
            return Err(std::io::Error::other("exported PGN exceeds byte limit"));
        }
        Ok(())
    }
}

fn classify_database_open_error<T>(
    context: &str,
    error: Error,
    deferred: T,
    unreadable: T,
) -> Result<T, Error> {
    if matches!(error.unlabelled(), Error::Cancellation) {
        Err(Error::Cancellation)
    } else if is_deferred_database_error(&error) {
        Ok(deferred)
    } else {
        log::warn!("{context} failed; treating database as unreadable: {error}");
        Ok(unreadable)
    }
}

/// Probes database identity (including `Info.DataRevision`) and reads `Info.Title` / `Info.GameCount`
/// through a read-only bound connection without invoking `schema_access`, `get_db_info`,
/// `get_db_or_create`, `validate_content`, or `pragma_integrity_check`.
pub(crate) fn read_cheap_database_info(
    repository: &DatabaseRepository,
    target: &DatabaseFileTarget,
    max_games: usize,
    cancellation: &CancellationToken,
) -> Result<CheapDatabaseInfo, Error> {
    super::cancellation_check(cancellation)?;
    let identity = match repository.identity_from_probe(target, cancellation, true) {
        Ok(identity) => identity,
        Err(error) => {
            return classify_database_open_error(
                "cheap database identity probe",
                error,
                CheapDatabaseInfo::Deferred,
                CheapDatabaseInfo::Unreadable,
            );
        }
    };
    if identity.length == 0 {
        return Ok(CheapDatabaseInfo::Unreadable);
    }

    let info = match repository.with_read_only_connection(target, cancellation, |conn| {
        read_cheap_info_from_connection(conn, max_games)
    }) {
        Ok(Some(info)) => info,
        Ok(None) => return Ok(CheapDatabaseInfo::Unreadable),
        Err(error) => {
            return classify_database_open_error(
                "cheap database info query",
                error,
                CheapDatabaseInfo::Deferred,
                CheapDatabaseInfo::Unreadable,
            );
        }
    };

    if info.game_count > max_games as u64 {
        Ok(CheapDatabaseInfo::TooManyGames {
            identity,
            title: info.title,
            game_count: info.game_count,
        })
    } else if info.game_count == 0 {
        Ok(CheapDatabaseInfo::Empty {
            identity,
            title: info.title,
        })
    } else {
        Ok(CheapDatabaseInfo::Eligible {
            identity,
            title: info.title,
            game_count: info.game_count,
        })
    }
}

fn read_cheap_info_from_connection(
    conn: &mut SqliteConnection,
    max_games: usize,
) -> Result<Option<RawCheapInfo>, Error> {
    let tables_present = sql_query(
        "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN ('Info', 'Games')",
    )
    .get_result::<CountRow>(conn)?
    .count;
    if tables_present != 2 {
        return Ok(None);
    }

    let rows: Vec<InfoEntryRow> = sql_query(
        "SELECT Name AS name, Value AS value FROM Info WHERE Name IN ('Title', 'GameCount')",
    )
    .load(conn)?;

    let title = rows
        .iter()
        .find(|row| row.name == "Title")
        .and_then(|row| row.value.as_deref())
        .map(str::trim)
        .filter(|trimmed| !trimmed.is_empty())
        .map(str::to_owned);

    let parsed_game_count = rows
        .iter()
        .find(|row| row.name == "GameCount")
        .and_then(|row| row.value.as_deref())
        .map(str::trim)
        .and_then(|value| value.parse::<u64>().ok());

    let game_count = match parsed_game_count {
        Some(count) => count,
        None => {
            let limit_plus_one = i64::try_from(max_games)
                .unwrap_or(i64::MAX - 1)
                .saturating_add(1);
            let bounded = sql_query("SELECT COUNT(*) AS count FROM (SELECT 1 FROM Games LIMIT ?)")
                .bind::<BigInt, _>(limit_plus_one)
                .get_result::<CountRow>(conn)?
                .count;
            let Ok(count) = u64::try_from(bounded) else {
                return Ok(None);
            };
            count
        }
    };

    Ok(Some(RawCheapInfo { title, game_count }))
}

/// Opens a selected in-cap database through `DatabaseRepository::connection` and exports its games
/// deterministically (`order_by_id = true`) with hard game-count and byte-size bounds.
pub(crate) fn export_database_pgn_bounded(
    repository: &DatabaseRepository,
    target: &DatabaseFileTarget,
    max_games: usize,
    max_bytes: u64,
    cancellation: &CancellationToken,
) -> Result<BoundedDatabaseExport, Error> {
    super::cancellation_check(cancellation)?;
    let mut db = match repository.connection(target, Some(cancellation)) {
        Ok(db) => db,
        Err(error) => {
            return classify_database_open_error(
                "bounded PGN export open",
                error,
                BoundedDatabaseExport::Deferred,
                BoundedDatabaseExport::Unreadable,
            );
        }
    };
    export_connection_pgn_bounded(&mut db, max_games, max_bytes, cancellation)
}

fn export_connection_pgn_bounded(
    db: &mut SqliteConnection,
    max_games: usize,
    max_bytes: u64,
    cancellation: &CancellationToken,
) -> Result<BoundedDatabaseExport, Error> {
    super::cancellation_check(cancellation)?;
    let mut writer = BoundedHashWriter::new(max_bytes);
    let result = super::sqlite_cancellation::with_sqlite_cancellation(cancellation, || {
        super::export::stream_database_to_pgn(db, &mut writer, true, cancellation, Some(max_games))
    });
    match result {
        Ok(()) => {
            if writer.written_bytes() == 0 {
                Ok(BoundedDatabaseExport::Empty)
            } else {
                let (bytes, sha256) = writer.finish();
                Ok(BoundedDatabaseExport::Exported { bytes, sha256 })
            }
        }
        Err(error) if matches!(error.unlabelled(), Error::Cancellation) => Err(Error::Cancellation),
        Err(_) if writer.overflowed() => Ok(BoundedDatabaseExport::TooLarge),
        Err(error) if super::export::is_export_too_many_games(&error) => {
            Ok(BoundedDatabaseExport::TooManyGames)
        }
        Err(error) if super::export::is_export_game_invalid_input(&error) => {
            log::warn!("bounded PGN export failed with invalid game data: {error}");
            Ok(BoundedDatabaseExport::InvalidPgn)
        }
        Err(error) if is_deferred_database_error(&error) => Ok(BoundedDatabaseExport::Deferred),
        Err(error) => {
            log::warn!("bounded PGN export failed; treating database as unreadable: {error}");
            Ok(BoundedDatabaseExport::Unreadable)
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{
        path::Path,
        sync::{
            atomic::{AtomicUsize, Ordering},
            Arc, Barrier,
        },
        time::Duration,
    };

    use diesel::{connection::SimpleConnection, Connection};

    use super::*;
    use crate::db::{
        export::{ExportWriteBlock, EXPORT_ROW_COUNT, EXPORT_WRITE_BLOCK},
        migrations,
        repository::{configure_test_hooks, test_target},
    };

    const TEST_MAX_GAMES: usize = 5_000;
    const TEST_MAX_BYTES: u64 = 5 * 1024 * 1024;

    fn create_current_db(path: &Path, title: Option<&str>, game_count: Option<&str>) {
        let mut conn = SqliteConnection::establish(path.to_str().unwrap()).unwrap();
        conn.batch_execute(crate::db::CREATE_TABLES_SQL).unwrap();
        sql_query("INSERT OR REPLACE INTO Info (Name, Value) VALUES ('Version', ?)")
            .bind::<Text, _>(migrations::CURRENT_DATABASE_VERSION)
            .execute(&mut conn)
            .unwrap();
        sql_query("INSERT OR REPLACE INTO Info (Name, Value) VALUES ('Description', '')")
            .execute(&mut conn)
            .unwrap();
        match title {
            Some(value) => {
                sql_query("INSERT OR REPLACE INTO Info (Name, Value) VALUES ('Title', ?)")
                    .bind::<Text, _>(value)
                    .execute(&mut conn)
                    .unwrap();
            }
            None => {
                conn.batch_execute("DELETE FROM Info WHERE Name = 'Title';")
                    .unwrap();
            }
        }
        match game_count {
            Some(value) => {
                sql_query("INSERT OR REPLACE INTO Info (Name, Value) VALUES ('GameCount', ?)")
                    .bind::<Text, _>(value)
                    .execute(&mut conn)
                    .unwrap();
            }
            None => {
                conn.batch_execute("DELETE FROM Info WHERE Name = 'GameCount';")
                    .unwrap();
            }
        }
    }

    fn insert_minimal_games(path: &Path, count: usize) {
        let mut conn = SqliteConnection::establish(path.to_str().unwrap()).unwrap();
        conn.batch_execute("BEGIN IMMEDIATE;").unwrap();
        for i in 0..count {
            sql_query(
                "INSERT INTO Games (EventID, SiteID, Date, Round, WhiteID, BlackID, WhiteMaterial, BlackMaterial, Result, Moves, PlyCount) \
                 VALUES (0, 0, '2026.01.01', ?, 0, 0, 0, 0, '*', X'', 0)",
            )
            .bind::<Text, _>((i + 1).to_string())
            .execute(&mut conn)
            .unwrap();
        }
        conn.batch_execute("COMMIT;").unwrap();
    }

    fn seed_legacy_1_0_0_corrupt_for_validate_content(
        path: &Path,
        title: &str,
        game_count: Option<&str>,
    ) {
        let mut conn = SqliteConnection::establish(path.to_str().unwrap()).unwrap();
        conn.batch_execute(
            "CREATE TABLE Info (Name TEXT UNIQUE NOT NULL, Value TEXT);
             CREATE TABLE Players (ID INTEGER PRIMARY KEY, Name TEXT UNIQUE, Elo INTEGER);
             CREATE TABLE Events (ID INTEGER PRIMARY KEY AUTOINCREMENT, Name TEXT UNIQUE);
             CREATE TABLE Sites (ID INTEGER PRIMARY KEY AUTOINCREMENT, Name TEXT UNIQUE);
             CREATE TABLE Games (
                 ID INTEGER PRIMARY KEY AUTOINCREMENT,
                 EventID INTEGER,
                 SiteID INTEGER,
                 Date TEXT,
                 UTCTime TEXT,
                 Round INTEGER,
                 WhiteID INTEGER,
                 WhiteElo INTEGER,
                 BlackID INTEGER,
                 BlackElo INTEGER,
                 WhiteMaterial INTEGER,
                 BlackMaterial INTEGER,
                 Result INTEGER,
                 TimeControl TEXT,
                 ECO TEXT,
                 PlyCount INTEGER,
                 FEN TEXT,
                 Moves BLOB,
                 PawnHome BLOB
             );
             INSERT INTO Info VALUES ('Version', '1.0.0');
             CREATE TABLE ContentValidationCorruption (Value TEXT);
             INSERT INTO ContentValidationCorruption VALUES (NULL);
             PRAGMA writable_schema=ON;
             UPDATE sqlite_master
                SET sql='CREATE TABLE ContentValidationCorruption (Value TEXT NOT NULL)'
              WHERE type='table' AND name='ContentValidationCorruption';
             PRAGMA writable_schema=OFF;",
        )
        .unwrap();
        sql_query("INSERT INTO Info (Name, Value) VALUES ('Title', ?)")
            .bind::<Text, _>(title)
            .execute(&mut conn)
            .unwrap();
        if let Some(count) = game_count {
            sql_query("INSERT INTO Info (Name, Value) VALUES ('GameCount', ?)")
                .bind::<Text, _>(count)
                .execute(&mut conn)
                .unwrap();
        }
    }

    #[test]
    fn identity_revision_changes_on_wal_write_without_main_file_metadata_change() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("wal_revision.db3");
        create_current_db(&path, Some("WAL DB"), Some("1"));
        insert_minimal_games(&path, 1);

        let repository = DatabaseRepository::default();
        let target = test_target(&path);
        let token = CancellationToken::new();

        // Establish WAL mode and checkpoint so baseline metadata is settled.
        {
            let mut conn = repository.connection(&target, Some(&token)).unwrap();
            conn.batch_execute("PRAGMA wal_checkpoint(TRUNCATE);")
                .unwrap();
        }

        let before_probe = target.probe_current().unwrap();
        let before =
            read_cheap_database_info(&repository, &target, TEST_MAX_GAMES, &token).unwrap();
        let CheapDatabaseInfo::Eligible {
            identity: before_identity,
            ..
        } = before
        else {
            panic!("expected Eligible before WAL write, got {before:?}");
        };

        // Keep a pooled connection open with autocheckpoint disabled so the WAL write
        // updates Info.DataRevision without modifying main-file length or mtime.
        let mut conn = repository.connection(&target, Some(&token)).unwrap();
        conn.batch_execute(
            "PRAGMA wal_autocheckpoint = 0;
             INSERT OR REPLACE INTO Info (Name, Value) VALUES ('DataRevision', '42');",
        )
        .unwrap();

        let after_probe = target.probe_current().unwrap();
        assert_eq!(after_probe.length, before_probe.length);
        assert_eq!(after_probe.modified, before_probe.modified);

        let after = read_cheap_database_info(&repository, &target, TEST_MAX_GAMES, &token).unwrap();
        let CheapDatabaseInfo::Eligible {
            identity: after_identity,
            ..
        } = after
        else {
            panic!("expected Eligible after WAL write, got {after:?}");
        };

        assert_eq!(after_identity.length, before_identity.length);
        assert_eq!(after_identity.modified, before_identity.modified);
        assert_eq!(after_identity.data_revision, 42);
        assert_ne!(after_identity, before_identity);
        drop(conn);
    }

    #[test]
    fn cheap_info_reads_game_count_and_falls_back_to_bounded_count_when_missing_or_invalid() {
        let dir = tempfile::tempdir().unwrap();
        let repository = DatabaseRepository::default();
        let token = CancellationToken::new();

        // Explicit GameCount = 150 with title.
        let p150 = dir.path().join("count_150.db3");
        create_current_db(&p150, Some("Personal Games"), Some("150"));
        let info =
            read_cheap_database_info(&repository, &test_target(&p150), TEST_MAX_GAMES, &token)
                .unwrap();
        match info {
            CheapDatabaseInfo::Eligible {
                title, game_count, ..
            } => {
                assert_eq!(title.as_deref(), Some("Personal Games"));
                assert_eq!(game_count, 150);
            }
            other => panic!("expected Eligible(150), got {other:?}"),
        }

        // Missing GameCount with 3 Games rows -> bounded count 3, never 0-by-default.
        let p_missing = dir.path().join("missing_count.db3");
        create_current_db(&p_missing, Some("Missing Count"), None);
        insert_minimal_games(&p_missing, 3);
        let info = read_cheap_database_info(
            &repository,
            &test_target(&p_missing),
            TEST_MAX_GAMES,
            &token,
        )
        .unwrap();
        match info {
            CheapDatabaseInfo::Eligible { game_count, .. } => assert_eq!(game_count, 3),
            other => panic!("expected Eligible(3), got {other:?}"),
        }

        // Unparseable GameCount ('abc') and negative ('-1') and NULL -> bounded count 3.
        for (name, sql) in [
            (
                "unparseable.db3",
                "INSERT OR REPLACE INTO Info (Name, Value) VALUES ('GameCount', 'abc');",
            ),
            (
                "negative.db3",
                "INSERT OR REPLACE INTO Info (Name, Value) VALUES ('GameCount', '-1');",
            ),
            (
                "null_count.db3",
                "INSERT OR REPLACE INTO Info (Name, Value) VALUES ('GameCount', NULL);",
            ),
        ] {
            let path = dir.path().join(name);
            create_current_db(&path, Some("Bad Count"), None);
            insert_minimal_games(&path, 3);
            let mut conn = SqliteConnection::establish(path.to_str().unwrap()).unwrap();
            conn.batch_execute(sql).unwrap();
            drop(conn);

            let info =
                read_cheap_database_info(&repository, &test_target(&path), TEST_MAX_GAMES, &token)
                    .unwrap();
            match info {
                CheapDatabaseInfo::Eligible { game_count, .. } => assert_eq!(game_count, 3),
                other => panic!("{name}: expected Eligible(3), got {other:?}"),
            }
        }

        // Missing GameCount with 0 Games rows -> Empty.
        let p_empty = dir.path().join("empty_missing.db3");
        create_current_db(&p_empty, Some("Empty"), None);
        let info =
            read_cheap_database_info(&repository, &test_target(&p_empty), TEST_MAX_GAMES, &token)
                .unwrap();
        assert!(matches!(info, CheapDatabaseInfo::Empty { .. }));

        // Exact cap (Info.GameCount == max_games) -> Eligible, not TooManyGames.
        let p_exact = dir.path().join("exact_cap.db3");
        let exact_str = TEST_MAX_GAMES.to_string();
        create_current_db(&p_exact, Some("Exact Cap"), Some(&exact_str));
        let info =
            read_cheap_database_info(&repository, &test_target(&p_exact), TEST_MAX_GAMES, &token)
                .unwrap();
        match info {
            CheapDatabaseInfo::Eligible { game_count, .. } => {
                assert_eq!(game_count, TEST_MAX_GAMES as u64);
            }
            other => panic!("expected Eligible({TEST_MAX_GAMES}), got {other:?}"),
        }
    }

    #[test]
    fn over_cap_legacy_database_skips_schema_access_and_validate_content() {
        let dir = tempfile::tempdir().unwrap();
        let repository = DatabaseRepository::default();
        let token = CancellationToken::new();

        // Witness 1: Info.GameCount = 5001 on a legacy 1.0.0 fixture with a corruption defect
        // that trips validate_content / pragma_integrity_check if schema_access is entered.
        let path = dir.path().join("legacy_mega.db3");
        seed_legacy_1_0_0_corrupt_for_validate_content(&path, "Legacy Mega", Some("5001"));
        let target = test_target(&path);

        let info = read_cheap_database_info(&repository, &target, TEST_MAX_GAMES, &token).unwrap();
        match info {
            CheapDatabaseInfo::TooManyGames {
                title, game_count, ..
            } => {
                assert_eq!(title.as_deref(), Some("Legacy Mega"));
                assert_eq!(game_count, 5001);
            }
            other => panic!("expected TooManyGames(5001), got {other:?}"),
        }

        // Prove schema_access / upgrade never ran: Version is still 1.0.0.
        let version = {
            #[derive(QueryableByName)]
            struct ValRow {
                #[diesel(sql_type = Nullable<Text>)]
                value: Option<String>,
            }
            let mut conn = SqliteConnection::establish(path.to_str().unwrap()).unwrap();
            sql_query("SELECT Value AS value FROM Info WHERE Name = 'Version'")
                .get_result::<ValRow>(&mut conn)
                .unwrap()
                .value
                .unwrap()
        };
        assert_eq!(version, "1.0.0");

        // Prove the witness itself trips validate_content when schema_access IS entered.
        assert!(
            repository.connection(&target, Some(&token)).is_err(),
            "witness fixture must fail if schema_access / validate_content is entered"
        );

        // Witness 2: Missing GameCount with strictly more than max_games + 1 Games rows on a
        // legacy 1.0.0 fixture. Bounded COUNT must stop at max_games + 1 (reverting to an
        // unbounded COUNT(*) FROM Games would return TEST_MAX_GAMES + 25 and fail).
        let bounded_path = dir.path().join("legacy_bounded_overcap.db3");
        seed_legacy_1_0_0_corrupt_for_validate_content(&bounded_path, "Legacy Bounded", None);
        {
            let mut conn = SqliteConnection::establish(bounded_path.to_str().unwrap()).unwrap();
            conn.batch_execute("BEGIN IMMEDIATE;").unwrap();
            for _ in 0..(TEST_MAX_GAMES + 25) {
                conn.batch_execute(
                    "INSERT INTO Games (EventID, SiteID, WhiteID, BlackID) VALUES (0, 0, 0, 0);",
                )
                .unwrap();
            }
            conn.batch_execute("COMMIT;").unwrap();
        }
        let bounded_info = read_cheap_database_info(
            &repository,
            &test_target(&bounded_path),
            TEST_MAX_GAMES,
            &token,
        )
        .unwrap();
        match bounded_info {
            CheapDatabaseInfo::TooManyGames { game_count, .. } => {
                assert_eq!(game_count, (TEST_MAX_GAMES + 1) as u64);
            }
            other => panic!("expected TooManyGames(5001) from bounded count, got {other:?}"),
        }
    }

    #[test]
    fn bounded_writer_overflows_without_buffering_and_order_by_id_is_byte_identical() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("bounded.db3");
        create_current_db(&path, Some("Bounded"), Some("200"));
        insert_minimal_games(&path, 200);

        let repository = DatabaseRepository::default();
        let target = test_target(&path);
        let token = CancellationToken::new();

        // Deterministic export: two exports are byte-identical and hash matches SHA-256.
        let first = export_database_pgn_bounded(
            &repository,
            &target,
            TEST_MAX_GAMES,
            TEST_MAX_BYTES,
            &token,
        )
        .unwrap();
        let second = export_database_pgn_bounded(
            &repository,
            &target,
            TEST_MAX_GAMES,
            TEST_MAX_BYTES,
            &token,
        )
        .unwrap();
        let (first_bytes, first_sha) = match first {
            BoundedDatabaseExport::Exported { bytes, sha256 } => (bytes, sha256),
            other => panic!("expected Exported, got {other:?}"),
        };
        let (second_bytes, second_sha) = match second {
            BoundedDatabaseExport::Exported { bytes, sha256 } => (bytes, sha256),
            other => panic!("expected Exported, got {other:?}"),
        };
        assert_eq!(first_bytes, second_bytes);
        assert_eq!(first_sha, second_sha);
        assert_eq!(first_sha, format!("{:x}", Sha256::digest(&first_bytes)));
        assert!(first_bytes.len() > 2048);

        // Overflow at a small byte limit stops early without buffering the rest of the database.
        let observed_rows = Arc::new(AtomicUsize::new(0));
        EXPORT_ROW_COUNT.with(|slot| *slot.borrow_mut() = Some(Arc::clone(&observed_rows)));
        let overflow =
            export_database_pgn_bounded(&repository, &target, TEST_MAX_GAMES, 512, &token);
        EXPORT_ROW_COUNT.with(|slot| *slot.borrow_mut() = None);
        assert_eq!(overflow.unwrap(), BoundedDatabaseExport::TooLarge);
        let rows_read = observed_rows.load(Ordering::Relaxed);
        assert!(
            rows_read < 200,
            "expected export to stop before reading all 200 rows, read {rows_read}"
        );

        // Direct BoundedHashWriter unit check: never buffers past max_bytes.
        let mut writer = BoundedHashWriter::new(10);
        assert_eq!(writer.write(b"12345").unwrap(), 5);
        assert!(!writer.overflowed());
        assert!(writer.write(b"678901").is_err());
        assert!(writer.overflowed());
        assert!(writer.written_bytes() <= 10);
        let (bytes, _) = writer.finish();
        assert!(bytes.is_empty());
    }

    #[test]
    fn stale_game_count_hits_max_games_without_writing_game_5001() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("stale_5001.db3");
        create_current_db(&path, Some("Stale Count"), Some("100"));
        insert_minimal_games(&path, 5_001);

        let repository = DatabaseRepository::default();
        let target = test_target(&path);
        let token = CancellationToken::new();

        // Cheap Info sees the stale GameCount = 100 and marks it Eligible.
        let info = read_cheap_database_info(&repository, &target, TEST_MAX_GAMES, &token).unwrap();
        assert!(matches!(
            info,
            CheapDatabaseInfo::Eligible {
                game_count: 100,
                ..
            }
        ));

        // Bounded export hits max_games = 5_000 (well under 5 MiB) and stops before game 5001.
        let observed_rows = Arc::new(AtomicUsize::new(0));
        EXPORT_ROW_COUNT.with(|slot| *slot.borrow_mut() = Some(Arc::clone(&observed_rows)));
        let result = export_database_pgn_bounded(
            &repository,
            &target,
            TEST_MAX_GAMES,
            TEST_MAX_BYTES,
            &token,
        );
        EXPORT_ROW_COUNT.with(|slot| *slot.borrow_mut() = None);

        assert_eq!(result.unwrap(), BoundedDatabaseExport::TooManyGames);
        assert_eq!(
            observed_rows.load(Ordering::Relaxed),
            TEST_MAX_GAMES,
            "must stop before decoding or writing game 5001"
        );
    }

    #[test]
    fn cancellation_during_info_and_export_returns_error_cancellation() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cancel.db3");
        create_current_db(&path, Some("Cancel DB"), Some("5"));
        insert_minimal_games(&path, 5);

        let repository = DatabaseRepository::default();
        let target = test_target(&path);

        // Cancelled before Info read.
        let cancelled = CancellationToken::new();
        cancelled.cancel();
        assert!(matches!(
            read_cheap_database_info(&repository, &target, TEST_MAX_GAMES, &cancelled),
            Err(Error::Cancellation)
        ));

        // Cancelled mid-Info during identity_from_probe via after_read_revision hook.
        {
            let mid_info_token = CancellationToken::new();
            let callback_token = mid_info_token.clone();
            let reads = Arc::new(AtomicUsize::new(0));
            let observed_reads = Arc::clone(&reads);
            let _hooks = configure_test_hooks(&path, move |hooks| {
                hooks.after_read_revision = Some(Box::new(move || {
                    observed_reads.fetch_add(1, Ordering::SeqCst);
                    callback_token.cancel();
                }));
            });
            assert!(matches!(
                read_cheap_database_info(&repository, &target, TEST_MAX_GAMES, &mid_info_token),
                Err(Error::Cancellation)
            ));
            assert_eq!(reads.load(Ordering::SeqCst), 1);
        }

        // Cancelled mid-export using EXPORT_WRITE_BLOCK.
        let token = CancellationToken::new();
        let block = Arc::new(ExportWriteBlock {
            entered: Barrier::new(2),
            release: Barrier::new(2),
        });
        let block_worker = Arc::clone(&block);
        let token_worker = token.clone();
        let export_path = path.clone();

        let result = std::thread::scope(|scope| {
            let handle = scope.spawn(move || {
                EXPORT_WRITE_BLOCK.with(|slot| *slot.borrow_mut() = Some(block_worker));
                let target = test_target(&export_path);
                let out = export_database_pgn_bounded(
                    &repository,
                    &target,
                    TEST_MAX_GAMES,
                    TEST_MAX_BYTES,
                    &token_worker,
                );
                EXPORT_WRITE_BLOCK.with(|slot| *slot.borrow_mut() = None);
                out
            });
            block.entered.wait();
            token.cancel();
            block.release.wait();
            handle.join().unwrap()
        });

        assert!(matches!(result, Err(Error::Cancellation)));
    }

    #[test]
    fn busy_and_conflict_are_deferred_distinct_from_corrupt_unreadable() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("busy_conflict.db3");
        create_current_db(&path, Some("Busy DB"), Some("1"));
        insert_minimal_games(&path, 1);

        let repository =
            DatabaseRepository::with_pool_connection_timeout(Duration::from_millis(150));
        let target = test_target(&path);
        let token = CancellationToken::new();

        // Tombstone triggers Error::Conflict on identity, cheap-info, and export-open -> Deferred.
        repository.insert_tombstone_for_test(target.path().to_path_buf());
        assert_eq!(
            read_cheap_database_info(&repository, &target, TEST_MAX_GAMES, &token).unwrap(),
            CheapDatabaseInfo::Deferred
        );
        assert_eq!(
            export_database_pgn_bounded(
                &repository,
                &target,
                TEST_MAX_GAMES,
                TEST_MAX_BYTES,
                &token
            )
            .unwrap(),
            BoundedDatabaseExport::Deferred
        );
        repository.remove_tombstone_for_test(target.path());

        // Exclusive SQLite lock triggers is_database_busy() -> Deferred on cheap Info.
        let mut locker = SqliteConnection::establish(path.to_str().unwrap()).unwrap();
        locker.batch_execute("BEGIN EXCLUSIVE;").unwrap();
        assert_eq!(
            read_cheap_database_info(&repository, &target, TEST_MAX_GAMES, &token).unwrap(),
            CheapDatabaseInfo::Deferred
        );
        locker.batch_execute("ROLLBACK;").unwrap();
        drop(locker);

        // CR-1: any Error::Conflict (not a closed message list) is deferred, while corrupt /
        // not-a-database / uninitialized are not.
        assert!(is_deferred_database_error(&Error::Conflict(
            "database changed while reading its identity".into()
        )));
        assert!(is_deferred_database_error(&Error::Conflict(
            "database changed after capability resolution".into()
        )));
        assert!(is_deferred_database_error(&Error::Conflict(
            "database construction timed out".into()
        )));
        assert!(is_deferred_database_error(&Error::Conflict(
            "unexpected transient conflict".into()
        )));
        assert!(!is_deferred_database_error(&Error::InvalidInput(
            "SQLite file is not a database".into()
        )));
        assert!(!is_deferred_database_error(&Error::InvalidInput(
            "SQLite integrity_check failed".into()
        )));
        assert!(!is_deferred_database_error(
            &migrations::uninitialized_database_error()
        ));

        // Corrupt / non-SQLite file -> Unreadable (never Deferred).
        let not_db = dir.path().join("not_a_db.db3");
        std::fs::write(&not_db, b"definitely not a sqlite database").unwrap();
        let not_db_target = test_target(&not_db);
        assert_eq!(
            read_cheap_database_info(&repository, &not_db_target, TEST_MAX_GAMES, &token).unwrap(),
            CheapDatabaseInfo::Unreadable
        );
        assert_eq!(
            export_database_pgn_bounded(
                &repository,
                &not_db_target,
                TEST_MAX_GAMES,
                TEST_MAX_BYTES,
                &token
            )
            .unwrap(),
            BoundedDatabaseExport::Unreadable
        );
    }

    #[test]
    fn per_game_invalid_fen_and_movetext_are_distinct_from_uninitialized_and_not_a_database() {
        let dir = tempfile::tempdir().unwrap();
        let repository = DatabaseRepository::default();
        let token = CancellationToken::new();

        // Per-game invalid FEN -> InvalidPgn.
        let bad_fen = dir.path().join("bad_fen.db3");
        create_current_db(&bad_fen, Some("Bad FEN"), Some("1"));
        {
            let mut conn = SqliteConnection::establish(bad_fen.to_str().unwrap()).unwrap();
            conn.batch_execute(
                "INSERT INTO Games (EventID, SiteID, WhiteID, BlackID, WhiteMaterial, BlackMaterial, Result, FEN, Moves) \
                 VALUES (0, 0, 0, 0, 0, 0, '*', 'not-a-valid-fen', X'');",
            )
            .unwrap();
        }
        assert_eq!(
            export_database_pgn_bounded(
                &repository,
                &test_target(&bad_fen),
                TEST_MAX_GAMES,
                TEST_MAX_BYTES,
                &token
            )
            .unwrap(),
            BoundedDatabaseExport::InvalidPgn
        );

        // Per-game invalid movetext -> InvalidPgn.
        let bad_moves = dir.path().join("bad_moves.db3");
        create_current_db(&bad_moves, Some("Bad Moves"), Some("1"));
        {
            let mut conn = SqliteConnection::establish(bad_moves.to_str().unwrap()).unwrap();
            conn.batch_execute(
                "INSERT INTO Games (EventID, SiteID, WhiteID, BlackID, WhiteMaterial, BlackMaterial, Result, Moves) \
                 VALUES (0, 0, 0, 0, 0, 0, '*', X'FF');",
            )
            .unwrap();
        }
        assert_eq!(
            export_database_pgn_bounded(
                &repository,
                &test_target(&bad_moves),
                TEST_MAX_GAMES,
                TEST_MAX_BYTES,
                &token
            )
            .unwrap(),
            BoundedDatabaseExport::InvalidPgn
        );

        // Uninitialized 0-byte file -> Unreadable (not InvalidPgn).
        let uninit = dir.path().join("uninitialized.db3");
        std::fs::write(&uninit, b"").unwrap();
        assert_eq!(
            export_database_pgn_bounded(
                &repository,
                &test_target(&uninit),
                TEST_MAX_GAMES,
                TEST_MAX_BYTES,
                &token
            )
            .unwrap(),
            BoundedDatabaseExport::Unreadable
        );

        // Non-SQLite file -> Unreadable (not InvalidPgn).
        let not_sqlite = dir.path().join("garbage.db3");
        std::fs::write(&not_sqlite, b"not sqlite bytes").unwrap();
        assert_eq!(
            export_database_pgn_bounded(
                &repository,
                &test_target(&not_sqlite),
                TEST_MAX_GAMES,
                TEST_MAX_BYTES,
                &token
            )
            .unwrap(),
            BoundedDatabaseExport::Unreadable
        );
    }

    #[test]
    fn blank_info_title_is_reported_as_none_for_filename_fallback() {
        let dir = tempfile::tempdir().unwrap();
        let repository = DatabaseRepository::default();
        let token = CancellationToken::new();

        for (filename, title) in [
            ("empty_title.db3", Some("")),
            ("whitespace_title.db3", Some("   \t\n  ")),
            ("missing_title.db3", None),
        ] {
            let path = dir.path().join(filename);
            create_current_db(&path, title, Some("1"));
            let info =
                read_cheap_database_info(&repository, &test_target(&path), TEST_MAX_GAMES, &token)
                    .unwrap();
            match info {
                CheapDatabaseInfo::Eligible { title, .. } => {
                    assert_eq!(title, None, "{filename} should report None for blank Title");
                }
                other => panic!("{filename}: expected Eligible, got {other:?}"),
            }
        }

        // NULL Title row -> None.
        let null_title = dir.path().join("null_title.db3");
        create_current_db(&null_title, None, Some("1"));
        {
            let mut conn = SqliteConnection::establish(null_title.to_str().unwrap()).unwrap();
            conn.batch_execute("INSERT INTO Info (Name, Value) VALUES ('Title', NULL);")
                .unwrap();
        }
        let info = read_cheap_database_info(
            &repository,
            &test_target(&null_title),
            TEST_MAX_GAMES,
            &token,
        )
        .unwrap();
        assert!(matches!(
            info,
            CheapDatabaseInfo::Eligible { title: None, .. }
        ));

        // Non-blank Title with surrounding whitespace -> trimmed Some.
        let trimmed = dir.path().join("trimmed_title.db3");
        create_current_db(&trimmed, Some("  Club Games  "), Some("1"));
        let info =
            read_cheap_database_info(&repository, &test_target(&trimmed), TEST_MAX_GAMES, &token)
                .unwrap();
        assert!(matches!(
            info,
            CheapDatabaseInfo::Eligible {
                title: Some(ref t),
                ..
            } if t == "Club Games"
        ));
    }

    #[test]
    fn write_pgn_rows_unpacks_row_error_before_game_cap() {
        let token = CancellationToken::new();
        let error = crate::db::export::write_pgn_rows(
            Vec::new(),
            [Err(diesel::result::Error::NotFound)],
            &token,
            Some(0),
        )
        .expect_err("row error must propagate instead of being masked as EXPORT_TOO_MANY_GAMES");
        assert!(!crate::db::export::is_export_too_many_games(&error));
        assert!(matches!(
            error.unlabelled(),
            Error::Diesel(inner) if matches!(inner.as_ref(), diesel::result::Error::NotFound)
        ));
    }

    #[test]
    fn order_by_id_preserves_ascending_id_order_under_reverse_unordered_selects() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("reverse_selects.db3");
        create_current_db(&path, Some("Ordered"), Some("10"));
        insert_minimal_games(&path, 10);

        let repository = DatabaseRepository::default();
        let target = test_target(&path);
        let token = CancellationToken::new();
        let mut conn = repository.connection(&target, Some(&token)).unwrap();
        conn.batch_execute("PRAGMA reverse_unordered_selects = ON;")
            .unwrap();

        let ordered =
            export_connection_pgn_bounded(&mut conn, TEST_MAX_GAMES, TEST_MAX_BYTES, &token)
                .unwrap();
        let ordered_bytes = match ordered {
            BoundedDatabaseExport::Exported { bytes, .. } => bytes,
            other => panic!("expected Exported, got {other:?}"),
        };

        let mut unordered_bytes = Vec::new();
        crate::db::export::stream_database_to_pgn(
            &mut conn,
            &mut unordered_bytes,
            false,
            &token,
            Some(TEST_MAX_GAMES),
        )
        .unwrap();

        conn.batch_execute("PRAGMA reverse_unordered_selects = OFF;")
            .unwrap();

        assert_ne!(
            ordered_bytes, unordered_bytes,
            "order_by_id=true must differ from unordered select under reverse_unordered_selects=ON"
        );
        let ordered_text = String::from_utf8(ordered_bytes).unwrap();
        let rounds: Vec<&str> = ordered_text
            .lines()
            .filter(|line| line.starts_with("[Round "))
            .collect();
        let expected: Vec<String> = (1..=10).map(|n| format!("[Round \"{n}\"]")).collect();
        let expected_refs: Vec<&str> = expected.iter().map(String::as_str).collect();
        assert_eq!(rounds, expected_refs);
    }

    #[test]
    fn export_database_pgn_bounded_returns_empty_for_zero_games() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("zero_games.db3");
        create_current_db(&path, Some("Zero Games"), Some("0"));

        let repository = DatabaseRepository::default();
        let target = test_target(&path);
        let token = CancellationToken::new();
        assert_eq!(
            export_database_pgn_bounded(
                &repository,
                &target,
                TEST_MAX_GAMES,
                TEST_MAX_BYTES,
                &token
            )
            .unwrap(),
            BoundedDatabaseExport::Empty
        );
    }

    #[test]
    fn cheap_info_returns_unreadable_for_zero_byte_file_and_missing_games_table() {
        let dir = tempfile::tempdir().unwrap();
        let repository = DatabaseRepository::default();
        let token = CancellationToken::new();

        // identity.length == 0 -> Unreadable.
        let zero_byte = dir.path().join("zero_byte.db3");
        std::fs::write(&zero_byte, b"").unwrap();
        assert_eq!(
            read_cheap_database_info(
                &repository,
                &test_target(&zero_byte),
                TEST_MAX_GAMES,
                &token
            )
            .unwrap(),
            CheapDatabaseInfo::Unreadable
        );

        // SQLite file with Info table but no Games table (tables_present != 2) -> Unreadable.
        let info_only = dir.path().join("info_only.db3");
        {
            let mut conn = SqliteConnection::establish(info_only.to_str().unwrap()).unwrap();
            conn.batch_execute(
                "CREATE TABLE Info (Name TEXT UNIQUE NOT NULL, Value TEXT);
                 INSERT INTO Info (Name, Value) VALUES ('Title', 'Info Only');
                 INSERT INTO Info (Name, Value) VALUES ('GameCount', '1');",
            )
            .unwrap();
        }
        assert_eq!(
            read_cheap_database_info(
                &repository,
                &test_target(&info_only),
                TEST_MAX_GAMES,
                &token
            )
            .unwrap(),
            CheapDatabaseInfo::Unreadable
        );
    }
}
